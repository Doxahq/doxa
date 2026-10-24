import type { Env } from "../env";
import { DocsDomainsRepository } from "../repositories/docs-domains";
import { createDocsHostnameUrl, createDocsUrl } from "./docs-url";

export async function withPreferredDocsUrls<T extends { id: string; slug: string }>(
  projects: T[],
  env: Env,
): Promise<Array<T & { docsUrl: string | null }>> {
  const preferredHostnames = await new DocsDomainsRepository(env).listPreferredCustomHostnames(
    projects.map((project) => project.id),
  );

  return projects.map((project) => withDocsUrl(project, env, preferredHostnames.get(project.id)));
}

export async function withPreferredDocsUrl<T extends { id: string; slug: string }>(
  project: T,
  env: Env,
): Promise<T & { docsUrl: string | null }> {
  const [result] = await withPreferredDocsUrls([project], env);
  return result;
}

export function withDocsUrl<T extends { slug: string }>(
  project: T,
  env: Env,
  preferredHostname?: string,
): T & { docsUrl: string | null } {
  return {
    ...project,
    docsUrl: preferredHostname
      ? createDocsHostnameUrl(preferredHostname, env)
      : createDocsUrl(project.slug, env),
  };
}
