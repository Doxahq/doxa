const snapshotTails = new Map<string, Promise<void>>();

/**
 * Serializes repository snapshot preparation for one destination within this
 * container process. Different destinations remain independent.
 */
export async function withSnapshotLock<T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = snapshotTails.get(destination) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous
    .catch(() => undefined)
    .then(() => gate);
  snapshotTails.set(destination, current);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (snapshotTails.get(destination) === current) {
      snapshotTails.delete(destination);
    }
  }
}
