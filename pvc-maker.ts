import { CoreV1Api } from "k8sApi/builtin/core@v1/mod.ts";
import { PersistentVolumeClaim } from "k8sApi/builtin/core@v1/structs.ts";
import { toQuantity } from "k8sApi/common.ts";

export function makePvcSpec({
  pvcName,
  capacity = "50Gi",
}: {
  pvcName: string;
  capacity?: string;
}): PersistentVolumeClaim {
  return {
    apiVersion: "v1" as const,
    kind: "PersistentVolumeClaim" as const,
    metadata: {
      name: pvcName,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: {
        requests: {
          storage: toQuantity(capacity),
        },
      },
      storageClassName: "managed-csi",
    },
  };
}

export async function createPvc(
  api: CoreV1Api,
  pvcName: string,
  namespace = "creditcoin"
) {
  const spec = makePvcSpec({ pvcName });
  return await api.namespace(namespace).createPersistentVolumeClaim(spec);
}
