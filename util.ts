export function assertNonEmpty<T>(x: T | undefined | null, extra = ""): T {
  if (!x) {
    throw new Error(`Expected non-empty value${extra ? `: ${extra}` : ""}`);
  }
  return x;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
