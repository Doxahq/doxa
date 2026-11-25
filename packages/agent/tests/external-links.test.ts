import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_OPEN_ISSUE_LIMITS, pageOpenIssueSchema } from "@doxahq/contracts/generation-reviews";
import { afterEach, describe, expect, test } from "vitest";
import {
  UNVERIFIED_EXTERNAL_LINK_CHECK,
  createRepositoryDomainIndex,
  externalDomainsOf,
  unverifiedExternalDomainsOf,
  unverifiedExternalLinkIssue,
  withUnverifiedExternalLinkIssue,
} from "../src/utils/external-links";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "doxa-links-")));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const GENERATED_PAGE = `---
title: "Sign in"
---

Read the [GitHub repository](https://github.com/acme/widget) first.

[Log in to your account](https://evil.example/login) to finish the setup.

![Logo](https://cdn.acme.dev/logo.png)
`;

describe("outside domains of a page", () => {
  test("finds links, images, attributes, protocol-relative URLs and userinfo tricks", () => {
    const content = [
      "[Docs](https://Docs.Acme.dev/start) and https://raw.example.org/file.",
      "![Shot](http://img.example.net:8080/a.png)",
      '<img src="//static.example.com/x.png" />',
      '<a href="https://github.com@phish.example/login">GitHub</a>',
      "Run it on http://localhost:3000 or http://127.0.0.1:8787.",
      "[Same](https://docs.acme.dev/other)",
    ].join("\n");

    expect(externalDomainsOf(content)).toEqual([
      "docs.acme.dev",
      "raw.example.org",
      "img.example.net",
      "phish.example",
      "127.0.0.1",
      "static.example.com",
    ]);
  });
});

describe("outside-link check against the repository", () => {
  test("flags evil.example when a generated page links to it and the repository does not contain it", async () => {
    const root = await repository({
      "README.md": "See https://github.com/acme/widget.\nAssets live on cdn.acme.dev.\n",
      "src/index.ts": "export const homepage = 'https://cdn.acme.dev';\n",
    });
    const index = createRepositoryDomainIndex({ cwd: root });

    await expect(unverifiedExternalDomainsOf(GENERATED_PAGE, index)).resolves.toEqual(["evil.example"]);
  });

  test("a domain that a repository file contains is not flagged, in any case", async () => {
    const root = await repository({ "README.md": "Log in at HTTPS://EVIL.EXAMPLE/login.\n" });
    const index = createRepositoryDomainIndex({ cwd: root });

    await expect(index.unverified(["evil.example"])).resolves.toEqual([]);
  });

  test("a longer domain in the repository does not verify a shorter one", async () => {
    const root = await repository({ "README.md": "Mirror: https://notevil.example and evil.example.com\n" });
    const index = createRepositoryDomainIndex({ cwd: root });

    await expect(index.unverified(["evil.example"])).resolves.toEqual(["evil.example"]);
  });

  test("pages in the docs output folder and dependency folders do not verify a domain", async () => {
    const root = await repository({
      "README.md": "# Widget\n",
      ".doxa/docs/default/sign-in.mdx": GENERATED_PAGE,
      "node_modules/pkg/README.md": "https://evil.example\n",
    });
    const index = createRepositoryDomainIndex({ cwd: root, excludedRoots: [join(root, ".doxa/docs")] });

    await expect(index.unverified(["evil.example"])).resolves.toEqual(["evil.example"]);
  });

  test("an excluded root that holds the whole repository is ignored", async () => {
    const root = await repository({ "README.md": "https://evil.example\n" });
    const index = createRepositoryDomainIndex({ cwd: root, excludedRoots: [root] });

    await expect(index.unverified(["evil.example"])).resolves.toEqual([]);
  });

  test("a failed scan flags nothing", async () => {
    const index = createRepositoryDomainIndex({ cwd: join(tmpdir(), "doxa-links-missing-repository") });

    await expect(index.unverified(["evil.example"])).resolves.toEqual([]);
  });
});

describe("the review issue of unverified domains", () => {
  test("names the domains in a bounded issue that the contract accepts", () => {
    const issue = unverifiedExternalLinkIssue(["evil.example"]);
    expect(issue).toEqual({
      check: UNVERIFIED_EXTERNAL_LINK_CHECK,
      message: "Links to a domain that the repository does not contain: evil.example. Check the links before you publish.",
      instructions: false,
    });

    const many = unverifiedExternalLinkIssue(Array.from({ length: 20 }, (_, index) => `host-${index}.very-long-domain-name.example`));
    expect(pageOpenIssueSchema.parse(many).message.length).toBeLessThanOrEqual(PAGE_OPEN_ISSUE_LIMITS.messageLength);
    expect(many?.message).toContain("host-0.very-long-domain-name.example");
    expect(many?.message).toContain("…");
    expect(unverifiedExternalLinkIssue([])).toBeNull();
  });

  test("goes after instruction breaks and before other issues, and replaces an earlier link issue", () => {
    const instruction = { check: "instructionTerminology", message: "Say repository.", instructions: true };
    const soft = { check: "thin-section", message: "A section is thin.", instructions: false };
    const stale = unverifiedExternalLinkIssue(["old.example"])!;

    const issues = withUnverifiedExternalLinkIssue([soft, stale, instruction], ["evil.example"]);
    expect(issues.map((issue) => issue.check)).toEqual([
      "instructionTerminology",
      UNVERIFIED_EXTERNAL_LINK_CHECK,
      "thin-section",
    ]);
    expect(issues[1]?.message).toContain("evil.example");
    expect(withUnverifiedExternalLinkIssue([soft, stale], [])).toEqual([soft]);
  });
});
