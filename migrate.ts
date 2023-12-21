import { CoreV1Api } from "k8sApi/builtin/core@v1/mod.ts";
import { BatchV1Api } from "k8sApi/builtin/batch@v1/mod.ts";
import { CopyLevel, makeMigrateJobSpec } from "./migrate-job.ts";
import { makePvcSpec } from "./pvc-maker.ts";
import { waitForJobCompletion } from "./jobs.ts";
import { assertNonEmpty } from "./util.ts";

export async function patchReclaimRetain(api: CoreV1Api, pvName: string) {
  const pv = await api.getPersistentVolume(pvName);
  if (pv.spec?.persistentVolumeReclaimPolicy === "Retain") {
    console.log(`PV ${pvName} already has Retain policy`);
    return;
  }
  console.log(`Patching PV ${pvName} to have Retain policy`);
  const patch = {
    spec: {
      persistentVolumeReclaimPolicy: "Retain",
    },
  };
  return await api.patchPersistentVolume(pvName, "strategic-merge", patch);
}

async function waitForRelease(api: CoreV1Api, pvName: string) {
  while (true) {
    const pv = await api.getPersistentVolume(pvName);
    if (pv.status?.phase === "Released") {
      return;
    }
    console.log(`Waiting for PV ${pvName} to be Released`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

export async function deleteClaimant(
  api: CoreV1Api,
  pvName: string,
  namespace = "creditcoin"
) {
  const pv = await api.getPersistentVolume(pvName);
  if (pv.spec?.persistentVolumeReclaimPolicy !== "Retain") {
    throw new Error("PV must have Retain policy");
  }
  if (!pv.spec.claimRef || !pv.spec.claimRef.name) {
    console.log(`PV ${pvName} already has no claimRef`);
    return pv;
  }
  console.log(`Deleting PVC ${pv.spec.claimRef.name}`);
  const nsApi = api.namespace(namespace);
  try {
    await nsApi.deletePersistentVolumeClaim(pv.spec.claimRef.name);
  } catch (_e) {
    console.log(`PVC ${pv.spec.claimRef.name} already deleted`);
    return;
  }
  console.log(`Deleted PVC ${pv.spec.claimRef.name}`);
  await waitForRelease(api, pvName);

  await removeClaimRef(api, pvName);
}

export async function removeClaimRef(api: CoreV1Api, pvName: string) {
  const pv = await api.getPersistentVolume(pvName);
  if (!pv.spec?.claimRef) {
    console.log(`PV ${pvName} already has no claimRef`);
    return pv;
  }
  if (pv.status?.phase !== "Released") {
    throw new Error("PV must be Released, not ${pv.status?.phase}");
  }
  console.log(
    `Patching PV ${pvName} to have no claimRef (was ${JSON.stringify(
      pv.spec?.claimRef
    )})`
  );
  const patch = [{ op: "remove" as const, path: "/spec/claimRef" }];
  return await api.patchPersistentVolume(pvName, "json-patch", patch);
}

export async function patchClaimRef(
  api: CoreV1Api,
  pvName: string,
  claimer: string,
  namespace = "creditcoin"
) {
  const pv = await api.getPersistentVolume(pvName);
  if (pv.status?.phase !== "Available") {
    throw new Error("PV must be Available");
  }
  console.log(
    `Patching PV ${pvName} to have claimRef ${claimer} (was ${JSON.stringify(
      pv.spec?.claimRef
    )})`
  );
  const patch = {
    spec: {
      claimRef: {
        namespace,
        name: claimer,
      },
    },
  };
  return await api.patchPersistentVolume(pvName, "strategic-merge", patch);
}

export async function getPodPvc(
  api: CoreV1Api,
  podName: string,
  namespace = "creditcoin"
) {
  const pod = await api.namespace(namespace).getPod(podName);
  if (!pod.spec?.volumes) {
    throw new Error(`Pod ${podName} has no volumes`);
  }
  const pvcName = pod.spec?.volumes?.at(0)?.persistentVolumeClaim?.claimName;
  if (!pvcName) {
    throw new Error(`Pod ${podName} has no PVC`);
  }
  return pvcName;
}

export function podPvcName(podName: string) {
  return `node-storage-${podName}`;
}

export async function getPvcVolume(
  api: CoreV1Api,
  pvcName: string,
  namespace = "creditcoin"
) {
  const pvc = await api.namespace(namespace).getPersistentVolumeClaim(pvcName);
  const name = pvc.spec?.volumeName;
  if (!name) {
    throw new Error(`PVC ${pvcName} has no volumeName`);
  }
  return name;
}

export async function patchPvcVolume(
  api: CoreV1Api,
  pvcName: string,
  toPvName: string,
  namespace = "creditcoin"
) {
  const pvc = await api.namespace(namespace).getPersistentVolumeClaim(pvcName);
  if (!pvc.spec?.volumeName) {
    throw new Error(`PVC ${pvcName} has no volumeName`);
  }
  if (pvc.spec!.volumeName === toPvName) {
    console.log(`PVC ${pvcName} already has volumeName ${toPvName}`);
    return;
  }
  console.log(
    `Patching PVC ${pvcName} to have volumeName ${toPvName} (was ${pvc.spec?.volumeName})`
  );
  const patch = {
    spec: {
      volumeName: toPvName,
    },
  };

  return await api
    .namespace(namespace)
    .patchPersistentVolumeClaim(pvcName, "strategic-merge", patch);
}

export async function rebindPvcToPv(
  api: CoreV1Api,
  pvcName: string,
  pvName: string,
  namespace = "creditcoin"
) {
  console.log(`Rebinding PVC ${pvcName} to PV ${pvName}`);
  const oldPv = await getPvcVolume(api, pvcName, namespace);
  console.log(`Old PV is ${oldPv}`);
  await patchReclaimRetain(api, oldPv);
  await deleteClaimant(api, oldPv, namespace);

  await patchReclaimRetain(api, pvName);
  await deleteClaimant(api, pvName, namespace);
  await patchClaimRef(api, pvName, pvcName, namespace);
}

export async function makeDummyPvc(
  api: CoreV1Api,
  pvcName: string,
  namespace = "creditcoin"
) {
  const spec = makePvcSpec({ pvcName });
  const nsApi = api.namespace(namespace);
  try {
    return await nsApi.createPersistentVolumeClaim(spec);
  } catch (_e) {
    console.log(
      `PVC ${pvcName} already exists (maybe) : ${JSON.stringify(_e, null, 2)}`
    );
    return;
  }
}

export async function migrateStorage(
  api: CoreV1Api,
  batchApi: BatchV1Api,
  existingPvcName: string,
  namespace = "creditcoin"
) {
  // Create a dummy PVC to provision a new PV
  const dummyPvcName = `dummy-for-${existingPvcName}`;
  console.log(`Creating dummy PVC ${dummyPvcName}`);
  await makeDummyPvc(api, dummyPvcName, namespace);

  // Migrate the data from the old PV to the new PV
  console.log(`Migrating data from ${existingPvcName} to ${dummyPvcName}`);
  const migrateJobSpec = makeMigrateJobSpec({
    srcClaim: existingPvcName,
    dstClaim: dummyPvcName,
    toCopy: CopyLevel.All,
    name: `migrate-${existingPvcName}`,
  });
  const migrateJob = await batchApi
    .namespace(namespace)
    .createJob(migrateJobSpec);
  const jobName = assertNonEmpty(migrateJob.metadata?.name, "bad migrate job");

  // Wait for the job to finish
  const success = await waitForJobCompletion(api, batchApi, jobName);
  if (!success) {
    throw new Error(`Migrate job ${migrateJob.metadata?.name} failed`);
  }

  const dummyPvcUpdated = await api
    .namespace(namespace)
    .getPersistentVolumeClaim(dummyPvcName);

  const dummyPvName = assertNonEmpty(
    dummyPvcUpdated.spec?.volumeName,
    `bad dummy PVC`
  );

  // Prebind the PVC to the new PV
  await rebindPvcToPv(api, existingPvcName, dummyPvName, namespace);
}
