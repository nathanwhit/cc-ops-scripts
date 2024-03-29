import { BatchV1Api } from "k8sApi/builtin/batch@v1/mod.ts";
import { Job } from "k8sApi/builtin/batch@v1/structs.ts";
import { assertNonEmpty } from "./util.ts";
import { CoreV1Api } from "k8sApi/builtin/core@v1/mod.ts";
import { waitForJobCompletion } from "./jobs.ts";
import $ from "https://deno.land/x/dax@0.35.0/mod.ts";

function makeJobSpec({
  pvcName,
  chainName,
  deleteFrontier,
}: {
  pvcName: string;
  chainName: string;
  deleteFrontier: boolean;
}): Job {
  const frontier = deleteFrontier
    ? `&& rm -rf /src_vol/chains/${chainName}/frontier`
    : "";
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `rm-rocksdb-${pvcName}`,
    },
    spec: {
      ttlSecondsAfterFinished: 15,
      template: {
        spec: {
          containers: [
            {
              name: "migrate",
              image: "debian",
              command: ["/bin/bash", "-c"],
              args: [
                `ls -lah /src_vol/chains/${chainName} && rm -rf /src_vol/chains/${chainName}/db ${frontier} && ls -lah /src_vol/chains/${chainName}`,
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

export async function deleteChain(
  api: CoreV1Api,
  batchApi: BatchV1Api,
  {
    pvcName,
    chainName = "creditcoin3_dev",
    namespace = "creditcoin",
    yes = false,
    deleteFrontier = true,
  }: {
    pvcName: string;
    chainName?: string;
    namespace?: string;
    yes?: boolean;
    deleteFrontier?: boolean;
  }
) {
  const jobSpec = makeJobSpec({ pvcName, chainName, deleteFrontier });
  // console.log(JSON.stringify(jobSpec, null, 2));
  const jobName = assertNonEmpty(jobSpec.metadata?.name, "jobName");
  if (yes || (await $.confirm(`Delete rocksdb for ${pvcName}?`))) {
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
}
