import { z } from "zod";

/** Git limits a ref to 255 bytes. Branch names are much shorter in practice. */
const MAX_BRANCH_NAME_LENGTH = 255;

/**
 * The parts of `git check-ref-format` that a branch name typed or picked in
 * the dashboard can break. GitHub still decides whether the branch exists.
 */
function isValidBranchName(name: string): boolean {
  return (
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("@{") &&
    name !== "@" &&
    // Spaces, control characters and the characters that git reserves.
    !/[\s\u0000-\u001f\u007f~^:?*[\\]/.test(name) &&
    name.split("/").every((part) => !part.startsWith("."))
  );
}

/** A branch name such as `main` or `release/2.x`, without `refs/heads/`. */
export const gitBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BRANCH_NAME_LENGTH)
  .refine(isValidBranchName, { message: "This is not a valid branch name." });

/** The branches of one repository, for the production branch picker. */
export const repositoryBranchesSchema = z
  .object({
    /** The repository's default branch on GitHub. */
    defaultBranch: z.string().min(1),
    /** Branch names, the default branch first, then in GitHub's order. */
    branches: z.array(z.string().min(1)),
    /**
     * False when the list stopped at the page limit. A branch missing from
     * it can still exist, so the picker also accepts a typed name.
     */
    complete: z.boolean(),
  })
  .strict();

export type RepositoryBranchesDto = z.infer<typeof repositoryBranchesSchema>;
