import { describe, expect, test } from "vitest";

import { prompts } from "../src/doxa-agent/prompts";
import {
  pageRoutesById,
  seedStructureFromSite,
  seedTextForPages,
} from "../src/doxa-agent/seed-structure";
import { analysisFixture } from "./fixtures";

const site = {
  sections: [
    {
      slug: "default",
      label: "Docs",
      isDefault: true,
      nodes: [
        { title: "Intro", href: "/" },
        { heading: "Guides" },
        { title: "Install", href: "/install" },
      ],
    },
    {
      slug: "faq",
      label: "FAQ",
      isDefault: false,
      nodes: [{ title: "Questions", href: "/faq/questions" }],
    },
  ],
  pages: [
    { href: "/", title: "Intro" },
    { href: "/install", title: "Install", description: "Set it up" },
    { href: "/faq/questions", title: "Questions" },
    { href: "/changelog", title: "Changelog" },
  ],
};

describe("seedStructureFromSite", () => {
  test("keeps sections, groups, titles, and every route", () => {
    const structure = seedStructureFromSite(site);

    expect(structure.sections).toEqual([
      {
        id: "default",
        title: "Docs",
        default: true,
        pages: [
          { id: "overview", title: "Intro", description: "Intro", canonicalRoute: "/" },
          {
            id: "install",
            title: "Install",
            description: "Set it up",
            canonicalRoute: "/install",
            group: "Guides",
          },
          { id: "changelog", title: "Changelog", description: "Changelog", canonicalRoute: "/changelog" },
        ],
      },
      {
        id: "faq",
        title: "FAQ",
        pages: [
          { id: "questions", title: "Questions", description: "Questions", canonicalRoute: "/faq/questions" },
        ],
      },
    ]);
    expect([...pageRoutesById(structure).values()]).toEqual([
      "/",
      "/install",
      "/changelog",
      "/faq/questions",
    ]);
  });

  test("gives each writer only the text of its own page", () => {
    const structure = seedStructureFromSite(site);
    const bodies = new Map([
      ["/install", "Run the installer."],
      ["/faq/questions", "Ask us."],
    ]);

    expect(
      seedTextForPages(structure, ["default/install", "default/overview"], bodies),
    ).toEqual({ "default/install": "Run the installer." });
  });

  test("puts the owner's page and the conflict comment in the writer prompt", () => {
    const structure = seedStructureFromSite(site);
    const page = structure.sections[0]!.pages[1]!;
    const prompt = prompts.buildWriterPrompt({
      analysis: analysisFixture,
      sectionTitle: "Docs",
      page,
      seedPageText: "Run the installer.",
    });

    expect(prompt.user).toContain("EXISTING PAGE FROM THE SITE OWNER");
    expect(prompt.user).toContain("<owner-page>\nRun the installer.\n</owner-page>");
    expect(prompt.user).toContain("doxa-seed-conflicts");
  });
});
