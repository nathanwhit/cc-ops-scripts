import { BatchV1Api } from "k8sApi/builtin/batch@v1/mod.ts";
import { CoreV1Api } from "k8sApi/builtin/core@v1/mod.ts";

export async function waitForJobCompletion(
  coreApi: CoreV1Api,
  batchApi: BatchV1Api,
  jobName: string,
  namespace = "creditcoin"
) {
  const nsApi = batchApi.namespace(namespace);
  const coreNsApi = coreApi.namespace(namespace);

  const jobPods = await coreNsApi.getPodList({
    labelSelector: `batch.kubernetes.io/job-name=${jobName}`,
  });

  const pullLogs = async () => {
    for (const pod of jobPods.items) {
      const logs = await coreNsApi.getPodLog(pod.metadata?.name || "");
      const fileName = `logs/${jobName}-${pod.metadata?.name}.log`;
      await Deno.writeTextFile(fileName, logs);
    }
  };
  while (true) {
    const job = await nsApi.getJobStatus(jobName);
    if (job.status?.succeeded) {
      await pullLogs();
      return true;
    } else if (job.status?.failed) {
      await pullLogs();
      return false;
    }
    console.log(`Waiting for job ${jobName} to finish`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
