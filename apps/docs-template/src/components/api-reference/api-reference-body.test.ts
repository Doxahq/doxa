import { createElement } from "react";
import type { RuntimeFeatureConfig } from "@/src/runtime/runtime-source";
import { parseRuntimeMdx } from "@doxahq/mdx-runtime";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { splitEndpointDocument } from "@/src/lib/endpoint-document";
import { ApiReferenceBody } from "@/src/components/api-reference/api-reference-body";
import {
  loadStoredRequestClient,
  requestClientName,
  saveStoredRequestClient,
  selectRequestSample,
} from "@/src/components/api-reference/request-clients";

const page = `---
title: Create a flag
description: Create a typed feature flag
apiMethod: POST
apiPath: /v1/projects/{projectId}/flags
---

Create a feature flag under an existing project.

<ApiEndpoint method="POST" path="/v1/projects/&#123;projectId&#125;/flags" baseUrl="https://api.example.com/v1">

<ApiRequestExample lang="curl" label="Create a flag">

\`\`\`bash
curl --request POST
\`\`\`

</ApiRequestExample>

<ApiResponseExample status="201" contentType="application/json">

\`\`\`json
{ "id": "flag_1" }
\`\`\`

</ApiResponseExample>

<ApiResponseExample status="404" contentType="application/json">

\`\`\`json
{ "error": "not_found" }
\`\`\`

</ApiResponseExample>

<ApiParams title="Path Parameters">
  <ApiParam name="projectId" type="string" location="path" required>
    Identifier of the project.
  </ApiParam>
</ApiParams>

</ApiEndpoint>
`;

const pageWithClients = page.replace(
  '<ApiRequestExample lang="curl" label="Create a flag">\n\n```bash\ncurl --request POST\n```\n\n</ApiRequestExample>',
  [
    '<ApiRequestExample client="curl" lang="bash" label="Create a flag">',
    "",
    "```bash",
    "curl --request POST",
    "```",
    "",
    "</ApiRequestExample>",
    "",
    '<ApiRequestExample client="go" lang="go" label="Create a flag">',
    "",
    "```go",
    'http.NewRequest("POST", url, nil)',
    "```",
    "",
    "</ApiRequestExample>",
  ].join("\n")
);

const features: RuntimeFeatureConfig = {
  branding: true,
  rightSidebar: true,
  feedbackEdit: false,
  tableOfContents: true,
  scrollToTop: true,
  ai: { chat: false, chatWithPage: false, floatingInput: false },
  copyPage: { markdown: true, rawText: true },
  apiPlayground: true,
  rawMarkdown: true,
  loadFromGithub: false,
};

function renderPage(featureConfig: RuntimeFeatureConfig = features): string {
  return renderToString(
    createElement(ApiReferenceBody, {
      document: parseRuntimeMdx(page),
      method: "POST",
      path: "/v1/projects/{projectId}/flags",
      features: featureConfig,
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API reference layout", () => {
  const html = renderPage();

  test("shows the method and the path with its parameter marked", () => {
    expect(html).toContain('aria-label="POST method"');
    expect(html).toContain("projects");
    expect(html).toContain("{projectId}");
  });

  test("shows the request sample once, in its own card", () => {
    expect(html).toContain("Create a flag");
    expect(html.split("curl --request POST").length - 1).toBe(1);
  });

  test("shows a plain client chip when the page has one request sample", () => {
    expect(html).toContain(">curl</span>");
    expect(html).not.toContain('data-slot="dropdown-menu-trigger"');
  });

  test("shows a client selector when the page has multiple request samples", () => {
    const html = renderToString(
      createElement(ApiReferenceBody, {
        document: parseRuntimeMdx(pageWithClients),
        method: "POST",
        path: "/v1/projects/{projectId}/flags",
        features,
      })
    );

    expect(html).toContain('data-slot="dropdown-menu-trigger"');
    expect(html).toContain("curl --request POST");
    expect(html).not.toContain("http.NewRequest");
  });

  test("selects the matching sample text for rendering and copying", () => {
    const endpoint = splitEndpointDocument(parseRuntimeMdx(pageWithClients));
    const selected = selectRequestSample(endpoint.request, "go");

    expect(selected?.client).toBe("go");
    expect(selected?.text).toContain("http.NewRequest");
  });

  test("uses renderer-owned client names and keeps unknown ids visible", () => {
    expect(requestClientName("node-fetch")).toBe("Node (Fetch)");
    expect(requestClientName("future-client")).toBe("future-client");
  });

  test("stores and loads the selected request client", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    saveStoredRequestClient("go");

    expect(loadStoredRequestClient()).toBe("go");
  });

  test("does not read local storage during server rendering", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("localStorage must not be read during render");
      },
    });

    expect(() =>
      renderToString(
        createElement(ApiReferenceBody, {
          document: parseRuntimeMdx(pageWithClients),
          method: "POST",
          path: "/v1/projects/{projectId}/flags",
          features,
        })
      )
    ).not.toThrow();
  });

  test("offers every documented response status", () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">201<");
    expect(html).toContain(">404<");
  });

  test("selects the first response before any interaction", () => {
    expect(html).toContain("flag_1");
    expect(html).not.toContain("not_found");
  });

  test("keeps the parameter groups in the main column", () => {
    expect(html).toContain("Path Parameters");
    expect(html).toContain("Identifier of the project.");
  });

  test("keeps the prose that precedes the endpoint block", () => {
    expect(html).toContain("Create a feature flag under an existing project.");
  });

  test("renders card samples without the shared code-block chrome", () => {
    // The shared `pre` adds a margin wrapper and its own copy button, which
    // would collide with the card header's copy button.
    expect(html).not.toContain('class="relative my-5"');
  });

  test("does not render the playground until a reader opens it", () => {
    expect(html).toContain("Try it");
    expect(html).not.toContain("Send request");
  });

  test("puts both samples above the parameter groups in one stack", () => {
    const request = html.indexOf("curl --request POST");
    const response = html.indexOf("flag_1");
    const parameters = html.indexOf("Path Parameters");

    expect(request).toBeGreaterThan(-1);
    expect(response).toBeGreaterThan(request);
    expect(parameters).toBeGreaterThan(response);
  });

  test("reserves the try-it slot between the endpoint bar and the samples", () => {
    const bar = html.indexOf('aria-label="POST method"');
    const slot = html.indexOf("endpoint-try-it");
    const request = html.indexOf("curl --request POST");

    expect(slot).toBeGreaterThan(bar);
    expect(request).toBeGreaterThan(slot);
  });

  test("hides the try-it control when no base URL is documented", () => {
    const withoutBaseUrl = renderToString(
      createElement(ApiReferenceBody, {
        document: parseRuntimeMdx(page.replace(/ baseUrl="[^"]*"/, "")),
        method: "POST",
        path: "/v1/projects/{projectId}/flags",
        features,
      })
    );

    expect(withoutBaseUrl).not.toContain("Try it");
    expect(withoutBaseUrl).toContain("curl --request POST");
  });

  test("hides the try-it control when the site setting disables the playground", () => {
    const html = renderPage({ ...features, apiPlayground: false });

    expect(html).not.toContain("Try it");
    expect(html).toContain("curl --request POST");
  });
});
