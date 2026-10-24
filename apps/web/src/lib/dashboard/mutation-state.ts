export function getPendingMutationId(
  isPending: boolean,
  domainId: string | undefined,
): string | null {
  return isPending ? domainId ?? null : null
}
