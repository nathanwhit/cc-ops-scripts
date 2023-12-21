import { BatchV1Api } from "k8sApi/builtin/batch@v1/mod.ts";
import { Job } from "k8sApi/builtin/batch@v1/structs.ts";
import { assertNonEmpty } from "./util.ts";
import { CoreV1Api } from "k8sApi/builtin/core@v1/mod.ts";
import { waitForJobCompletion } from "./jobs.ts";

function makeJobSpec(pvcName: string): Job {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `rm-rocksdb-${pvcName}`,
    },
    spec: {
      ttlSecondsAfterFinished: 60,
      template: {
        spec: {
          containers: [
            {
              name: "migrate",
              image: "debian",
              command: ["/bin/bash", "-c"],
              args: [
                "ls -lah /src_vol/chains/creditcoin && rm -rf /src_vol/chains/creditcoin/db && ls -lah /src_vol/chains/creditcoin",
              ],
              volumeMounts: [
                {
                  mountPath: "/src_vol",
                  name: "src",
                },
              ],
            },
          ],
          restartPolicy: "Never",
          volumes: [
            {
              name: "src",
              persistentVolumeClaim: {
                claimName: pvcName,
              },
            },
          ],
        },
      },
      backoffLimit: 0,
    },
  };
}

export async function deleteRocksdb(
  api: CoreV1Api,
  batchApi: BatchV1Api,
  pvcName: string,
  namespace = "creditcoin"
) {
  const jobSpec = makeJobSpec(pvcName);
  console.log(JSON.stringify(jobSpec, null, 2));
  const jobName = assertNonEmpty(jobSpec.metadata?.name, "jobName");
  const _job = await batchApi.namespace(namespace).createJob(jobSpec);
  const successful = await waitForJobCompletion(
    api,
    batchApi,
    jobName,
    namespace
  );
  if (!successful) {
    throw new Error(`Job ${jobName} failed`);
  }
}
