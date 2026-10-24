import { branchNameSchema } from "@doxahq/contracts/docs-branches"

export function branchNameError(name: string): string | null {
  const result = branchNameSchema.safeParse(name)
  if (result.success) return null
  const code = result.error.issues[0]?.message
  return code === "reserved_branch_name"
    ? "This branch name is reserved. Choose a different name."
    : "Use 1 to 40 lowercase letters, digits, or internal hyphens."
}
