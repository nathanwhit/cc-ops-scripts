import { KubectlRawRestClient } from "k8sClient/mod.ts";
import { CoreV1Api } from "k8sApi/builtin/core@v1/mod.ts";
import { BatchV1Api } from "k8sApi/builtin/batch@v1/mod.ts";
import { AppsV1Api } from "k8sApi/builtin/apps@v1/mod.ts";
import {
  Command,
  HelpCommand,
  ArgumentValue,
  ValidationError,
} from "https://deno.land/x/cliffy@v1.0.0-rc.3/command/mod.ts";
import {
  migrateStorage,
  patchClaimRef,
  podPvcName,
  removeClaimRef,
} from "./migrate.ts";
import { deleteRocksdb } from "./delete-rocksdb.ts";
import $ from "https://deno.land/x/dax@0.35.0/mod.ts";
import { Quantity, toQuantity } from "k8sApi/common.ts";
import { assertNonEmpty } from "./util.ts";

async function cleanupPvs(
  api: CoreV1Api,
  yes = false,
  pvcNamespace = "creditcoin"
) {
  const pvs = await api.getPersistentVolumeList();
  for (const pv of pvs.items) {
    const spec = pv.spec;
    if (!spec) {
      console.log("skipping, no spec");
      continue;
    }
    if (spec.storageClassName?.startsWith("azurefile")) {
      const name = pv.metadata?.name;
      if (!name) {
        console.log("skipping, no name");
        continue;
      }
      if (
        yes ||
        (await $.confirm(
          `Delete PV ${name} (has claim ${pv.spec?.claimRef?.name})`
        ))
      ) {
        const phase = pv.status?.phase;
        if (!phase) {
          console.log("skipping, no phase");
          continue;
        }
        if (phase === "Available") {
          console.log(`deleting PV ${name}`);
          await api.deletePersistentVolume(name);
        } else if (phase === "Released") {
          console.log(`removing claimRef from PV ${name}`);
          await removeClaimRef(api, name);
          console.log(`deleting PV ${name}`);
          await api.deletePersistentVolume(name);
        } else if (phase === "Bound") {
          const claimRef = spec.claimRef;
          if (!claimRef) {
            console.log("skipping, no claimRef");
            continue;
          }
          const claimName = claimRef.name;
          if (!claimName) {
            console.log("skipping, no claimName");
            continue;
          }
          const nsApi = api.namespace(claimRef.namespace ?? pvcNamespace);
          if (yes || (await $.confirm(`Delete PVC ${claimName}?`))) {
            const patch = {
              spec: {
                persistentVolumeReclaimPolicy: "Delete",
              },
            };
            if (spec.persistentVolumeReclaimPolicy === "Retain") {
              console.log(`patching PV ${name}`);
              await api.patchPersistentVolume(name, "strategic-merge", patch);
            }
            console.log(`deleting PVC ${claimName}`);
            await nsApi.deletePersistentVolumeClaim(claimName);
          }
        }
      }
    }
  }
}

async function fixReclaimPolicy(api: CoreV1Api, pvName: string) {
  const pv = await api.getPersistentVolume(pvName);
  if (pv.spec?.persistentVolumeReclaimPolicy === "Delete") {
    $.log(`skipping ${pvName}, already Delete`);
    return;
  }
  const patch = {
    spec: {
      persistentVolumeReclaimPolicy: "Delete",
    },
  };
  $.log(`patching ${pvName}`);
  await api.patchPersistentVolume(pvName, "strategic-merge", patch);
}

async function fixReclaimPolicies(api: CoreV1Api, yes = false) {
  const pvs = await api.getPersistentVolumeList();
  for (const pv of pvs.items) {
    const spec = pv.spec;
    if (!spec) {
      $.log("skipping, no spec");
      continue;
    }
    const name = pv.metadata?.name;
    if (!name) {
      $.log("skipping, no name");
      continue;
    }
    if (yes || (await $.confirm(`Patch ${name}?`))) {
      await fixReclaimPolicy(api, name);
    }
  }
}

// async function restartPod(
//   api: CoreV1Api,
//   podName: string,
//   namespace = "creditcoin"
// ) {
//   await api.namespace(namespace).deletePod(podName);

//   const isReady = (s: Pod) => {
//     return s.status?.containerStatuses?.every(({ ready }) => ready);
//   };
//   const getStatus = () => {
//     return api.namespace(namespace).getPodStatus(podName);
//   };

//   let status = await getStatus();

//   while (!isReady(status)) {
//     console.log("waiting for pod to be ready");
//     await sleep(2000);
//     status = await getStatus();
//   }
//   console.log(`pod ${podName} is ready`);
// }

async function resizeStatefulSetPvcs(
  api: CoreV1Api,
  appsApi: AppsV1Api,
  statefulsetName: string,
  newSize: Quantity,
  namespace = "creditcoin",
  dryRun = false
) {
  if (await $.confirm(`Delete statefulset ${statefulsetName}?`)) {
    await appsApi.namespace(namespace).deleteStatefulSet(
      statefulsetName,
      dryRun
        ? {
            dryRun: "client",
            propagationPolicy: "Orphan",
          }
        : {
            propagationPolicy: "Orphan",
          }
    );
  }

  const pvcs = await api.namespace(namespace).getPersistentVolumeClaimList();
  for (const pvc of pvcs.items) {
    const name = assertNonEmpty(pvc?.metadata?.name);
    if (name.startsWith("node-storage-") && name.includes(statefulsetName)) {
      const patch = {
        spec: {
          resources: {
            requests: {
              storage: newSize,
            },
          },
        },
      };
      console.log(`patching PVC ${name}`);
      if (!(await $.confirm(`Patch PVC ${name}?`))) {
        return;
      }
      await api.namespace(namespace).patchPersistentVolumeClaim(
        name,
        "strategic-merge",
        patch,
        dryRun
          ? {
              dryRun: "client",
            }
          : undefined
      );
    }
  }

  console.log(
    `%cYou now need to perform a helm upgrade for the statefulset, make sure you've updated the values for the helm chart to match the new PVC size!`,
    "color: orange"
  );
}

function quantityType({ label, name, value }: ArgumentValue): Quantity {
  const quantity = toQuantity(value);

  if (isNaN(quantity.number) || quantity.suffix.trim() === "") {
    throw new ValidationError(
      `${label} "${name}" must be a valid quantity, but got "${value}". A valid quantity is a number followed by a unit, e.g. "1Gi" or "1000M"`
    );
  }

  return quantity;
}

async function checkCluster() {
  const result =
    await $`kubectl config view --minify -o jsonpath='{.clusters[].name}'`.stdout(
      "piped"
    );
  const cluster = result.stdout.trim();
  if (
    !(await $.confirm(
      `Currently connected to ${cluster}, are you sure this is the right cluster?`
    ))
  ) {
    Deno.exit(1);
  }
}

const k8s = new KubectlRawRestClient();
const coreApi = new CoreV1Api(k8s);
const batchApi = new BatchV1Api(k8s);

await new Command()
  .name("disk-migration")
  .globalOption(
    "--no-confirm-cluster",
    "Skip prompt confirming you are on the right cluster"
  )
  .globalAction(async ({ confirmCluster }) => {
    if (confirmCluster) {
      await checkCluster();
    }
  })
  .version("0.1.0")
  .description("Disk migration tool for Creditcoin")
  .default("help")
  .command("help", new HelpCommand().global())

  .type("quantity", quantityType, {
    global: true,
  })

  .command("migrate")
  .arguments("<pod-name:string>")
  .option("-n, --namespace <namespace:string>", "Kubernetes namespace")
  .description("Migrate a PVC to a new PV")
  .action(async ({ namespace }, podName) => {
    const pvcName = podPvcName(podName);
    await migrateStorage(coreApi, batchApi, pvcName, namespace);
  })
  .command("delete-rocksdb")
  .arguments("<pod-name:string>")
  .option("-n, --namespace <namespace:string>", "Kubernetes namespace")
  .option("-y --yes", "Skip confirmation (USE WITH CAUTION)")
  .option("--chain-name <chain-name:string>", "Chain name")
  .description("Delete the rocksdb directory of a pod")
  .action(async ({ namespace, chainName, yes }, podName) => {
    const pvcName = podPvcName(podName);
    await deleteRocksdb(coreApi, batchApi, pvcName, chainName, namespace, yes);
  })
  .command("force-bind")
  .arguments("<pv-name:string> <pvc-name:string>")
  .option("-n, --namespace <namespace:string>", "Kubernetes namespace")
  .description("Force bind a PV to a PVC")
  .action(async ({ namespace }, pvName, pvcName) => {
    await patchClaimRef(coreApi, pvName, pvcName, namespace);
  })
  .command("cleanup-pvs")
  .description(
    "Delete PVs backed by azurefile storage, will prompt for confirmation before each destructive action"
  )
  .option("-y --yes", "Skip confirmation (USE WITH CAUTION)")
  .action(async ({ yes }) => {
    await cleanupPvs(coreApi, yes);
  })
  .command("fix-reclaim-policies")
  .description(
    "Make sure all PVs have reclaim policy set to 'Delete'. This only is useful if you've manually changed reclaim policices of PVs to 'Retain' in order to keep them around, and now you want to revert them back to 'Delete'"
  )
  .option("-y --yes", "Skip confirmation")
  .action(async ({ yes }) => {
    await fixReclaimPolicies(coreApi, yes);
  })
  .command("resize-statefulset-pvcs <statefulset-name:string>")
  .description(
    "Resize all PVCs for a statefulset. This will perform the actions on the k8s side, but you will need to perform a helm upgrade to update the PVC size in the helm chart values. It will print a warning at the end to remind you to do this."
  )
  .type("quantity", quantityType)
  .option("-n, --namespace <namespace:string>", "Kubernetes namespace")
  .option("--new-size <new-size:quantity>", "New size", { required: true })
  .option("--dry-run", "Dry run (no changes)")
  .action(async ({ namespace, newSize, dryRun }, stsName) => {
    const appsApi = new AppsV1Api(k8s);
    await resizeStatefulSetPvcs(
      coreApi,
      appsApi,
      stsName,
      newSize,
      namespace,
      dryRun
    );
  })
  .parse(Deno.args);
