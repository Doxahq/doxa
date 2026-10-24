import { describe, expect, test } from "vitest";
import {
  chooseFallbackIcon,
  iconCandidates,
  loadIconCatalog,
  resolveIconName,
} from "../src/navigation-icons";

function page(title: string, head: string) {
  return {
    title,
    head,
    section: "default",
    filename: `default/${title.toLowerCase().replace(/\s+/g, "-")}.md`,
  };
}

describe("deterministic navigation icons", () => {
  test("does not mistake a word substring for a CLI page", async () => {
    const catalog = await loadIconCatalog();

    expect(
      chooseFallbackIcon(catalog, {
        title: "Client",
        section: "API Reference",
        head: "Client class reference",
        filename: "api-reference/client.md",
      }),
    ).toBe("code");
  });

  test("prioritizes the page title over a parent folder name", async () => {
    const catalog = await loadIconCatalog();

    expect(
      chooseFallbackIcon(catalog, {
        title: "Install",
        section: "Guide",
        head: "Install the package",
        filename: "default/overview/install.md",
      }),
    ).toBe("package");
  });

  test.each([
    ["Quickstart", "Run the first example", "play"],
    ["Authentication", "Configure API keys", "key"],
    ["Troubleshooting", "Debug common errors", "circleHelp"],
    ["Configuration", "Set project options", "cog"],
    ["Deployment", "Run the service in production", "server"],
  ])(
    "selects a semantic icon for %s",
    async (title, head, expected) => {
      const catalog = await loadIconCatalog();

      expect(
        chooseFallbackIcon(catalog, {
          title,
          section: "Documentation",
          head,
          filename: `default/${title.toLowerCase()}.md`,
        }),
      ).toBe(expected);
    },
  );
});

describe("the full Lucide icon set", () => {
  test("lets a page use any Lucide icon, beside the suggested ones", async () => {
    const catalog = await loadIconCatalog();

    expect(catalog.lucideVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(catalog.names.size).toBeGreaterThan(1500);
    expect(catalog.names.has("webhook")).toBe(true);
    expect(catalog.names.has("rocket")).toBe(true);
    expect(catalog.prompt).toContain("rocket: Launch.");
    expect(catalog.prompt).toContain("Any other Lucide icon also works");
  });

  test.each([
    ["ship-wheel", "shipWheel"],
    ["CreditCard", "creditCard"],
    ["creditCard", "creditCard"],
    // A renamed Lucide icon resolves to its current name.
    ["helpCircle", "circleQuestionMark"],
    // A suggested name stays as pages already store it.
    ["circleHelp", "circleHelp"],
    ["madeUpIcon", null],
    ["", null],
  ])("resolves the model's icon %j to %j", async (value, expected) => {
    expect(resolveIconName(await loadIconCatalog(), value)).toBe(expected);
  });

  test.each([
    ["Webhooks", "Receive webhook events", "webhook"],
    ["Analytics", "Track usage metrics and charts", "chartArea"],
    ["Users and teams", "Manage members and roles", "userGroup"],
    ["Billing", "Invoices and subscriptions", "creditCardCheck"],
  ])("falls back to a Lucide icon for %s, which no suggested icon covers", async (title, head, expected) => {
    expect(chooseFallbackIcon(await loadIconCatalog(), page(title, head))).toBe(expected);
  });

  test("a common word does not choose an icon", async () => {
    const catalog = await loadIconCatalog();
    expect(iconCandidates(catalog, page("Users and teams", "Manage members"))).not.toContain("ampersand");
  });

  test("a match in the page text alone does not name the page", async () => {
    const catalog = await loadIconCatalog();
    const ratePage = page("Rate limits", "Requests per minute");

    expect(chooseFallbackIcon(catalog, ratePage)).not.toMatch(/^gitPullRequest/);
    // The model still sees it among the candidates.
    expect(iconCandidates(catalog, ratePage).length).toBeGreaterThan(0);
  });

  test("offers the closest Lucide icons as candidates, best first", async () => {
    const catalog = await loadIconCatalog();
    const candidates = iconCandidates(catalog, page("Email notifications", "Send transactional email"));

    expect(candidates).toEqual(expect.arrayContaining(["mail", "send"]));
    expect(candidates.length).toBeLessThanOrEqual(8);
  });
});
