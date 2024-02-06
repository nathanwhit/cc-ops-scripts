import { KubectlRawRestClient } from "k8sClient/mod.ts";
import { CoreV1Api } from "k8sApi/builtin/core@v1/mod.ts";
import { BatchV1Api } from "k8sApi/builtin/batch@v1/mod.ts";
import {
  Command,
  HelpCommand,
} from "https://deno.land/x/cliffy@v1.0.0-rc.3/command/mod.ts";
import {
  migrateStorage,
  patchClaimRef,
  podPvcName,
  removeClaimRef,
} from "./migrate.ts";
import { deleteRocksdb } from "./delete-rocksdb.ts";
import $ from "https://deno.land/x/dax@0.35.0/mod.ts";

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

const k8s = new KubectlRawRestClient();
const coreApi = new CoreV1Api(k8s);
const batchApi = new BatchV1Api(k8s);

await new Command()
  .name("disk-migration")
  .version("0.1.0")
  .description("Disk migration tool for Creditcoin")
  .default("help")
  .command("help", new HelpCommand().global())
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
  .option("-y --yes", "Skip confirmation (USE WITH CAUTION)")
  .action(async ({ yes }) => {
    await cleanupPvs(coreApi, yes);
  })
  .command("fix-reclaim-policies")
  .option("-y --yes", "Skip confirmation")
  .action(async ({ yes }) => {
    await fixReclaimPolicies(coreApi, yes);
  })
  .parse(Deno.args);
