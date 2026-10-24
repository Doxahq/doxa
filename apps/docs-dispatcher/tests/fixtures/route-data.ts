/** A valid public route-data DTO for the `/guide` page. */
export function createRouteData() {
  const section = { slug: "docs", label: "Docs", default: true };
  return {
    type: "page",
    slug: "guide",
    href: "/guide",
    homeHref: "/guide",
    canonicalUrl: "https://docs.example.com/guide",
    site: { name: "Demo", url: "https://docs.example.com" },
    features: {
      branding: true,
      rightSidebar: true,
      feedbackEdit: false,
      tableOfContents: true,
      scrollToTop: true,
      ai: { chat: false, chatWithPage: false, floatingInput: false },
      copyPage: { markdown: true, rawText: true },
      apiPlayground: false,
      rawMarkdown: true,
      loadFromGithub: false,
    },
    sections: [section],
    visibleSections: [section],
    currentSection: section,
    sectionHomeHrefs: { docs: "/guide" },
    sectionNavigation: [{ title: "Guide", href: "/guide" }],
    sectionRoutes: [{ title: "Guide", href: "/guide" }],
    routeTitle: "Guide",
    sectionHeading: null,
    previous: null,
    next: null,
    document: null,
    rawDoc: null,
    runtimeDocument: null,
  };
}
