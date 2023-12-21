import { Job } from "k8sApi/builtin/batch@v1/mod.ts";

function makeCmd(parts: string[]) {
  return parts.join(" && ");
}

export enum CopyLevel {
  All,
  ChainOnly,
  PrintOnly,
}

export function makeMigrateJobSpec({
  srcClaim,
  dstClaim,
  chain = "creditcoin",
  toCopy = CopyLevel.PrintOnly,
  name = `migrate-pv-${dstClaim}`,
}: {
  srcClaim: string;
  dstClaim: string;
  chain?: string;
  toCopy?: CopyLevel;
  name?: string;
}): Job {
  let extra = "";
  switch (toCopy) {
    case CopyLevel.All:
    case CopyLevel.PrintOnly:
      extra = "";
      break;
    case CopyLevel.ChainOnly:
      extra = "paritydb/full/";
      break;
  }
  const srcPath = `/src_vol/chains/${chain}/${extra}`.trim();
  const dstPath = `/dst_vol/chains/${chain}/${extra}`.trim();

  const cmd = makeCmd([
    "apt-get update",
    "apt-get install -y wget unzip",
    "wget https://downloads.rclone.org/v1.64.2/rclone-v1.64.2-linux-amd64.zip",
    "unzip rclone-v1.64.2-linux-amd64.zip",
    "cp rclone-v1.64.2-linux-amd64/rclone /usr/bin/",
    `rclone sync ${srcPath} ${dstPath} --progress --multi-thread-streams=8`,
    `du -shxc ${srcPath} ${dstPath}`,
  ]);
  const printCmd = makeCmd([`ls -lhxc ${srcPath}`, `ls -lhxc ${dstPath}`]);
  const fullCmd = toCopy === CopyLevel.PrintOnly ? printCmd : cmd;
  return {
    apiVersion: "batch/v1",
    metadata: {
      name,
    },
    spec: {
      ttlSecondsAfterFinished: 60,
      backoffLimit: 1,
      template: {
        spec: {
          containers: [
            {
              name: "migrate",
              image: "debian",
              command: ["/bin/bash", "-c"],
              args: [fullCmd],
              volumeMounts: [
                {
                  mountPath: "/src_vol",
                  name: "src",
                  readOnly: true,
                },
                {
                  mountPath: "/dst_vol",
                  name: "dst",
                },
              ],
            },
          ],
          restartPolicy: "Never",
          volumes: [
            {
              name: "src",
              persistentVolumeClaim: {
                claimName: srcClaim,
              },
            },
            {
              name: "dst",
              persistentVolumeClaim: {
                claimName: dstClaim,
              },
            },
          ],
        },
      },
    },
  };
}
