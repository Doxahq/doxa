import { parseRuntimeMdx } from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import {
  endpointPathSegments,
  nodeText,
  splitEndpointDocument,
} from "@/src/lib/endpoint-document";

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

<ApiParams title="Body">
  <ApiParam name="key" type="string" location="body" required>
    The flag key.
  </ApiParam>
</ApiParams>

</ApiEndpoint>
`;

describe("splitEndpointDocument", () => {
  const endpoint = splitEndpointDocument(parseRuntimeMdx(page));

  test("reads the base URL from the endpoint block", () => {
    expect(endpoint.baseUrl).toBe("https://api.example.com/v1");
  });

  test("collects one request sample with its label and language", () => {
    expect(endpoint.request).toHaveLength(1);
    expect(endpoint.request[0].client).toBe("curl");
    expect(endpoint.request[0].label).toBe("Create a flag");
    expect(endpoint.request[0].detail).toBe("curl");
    expect(endpoint.request[0].text).toContain("curl --request POST");
  });

  test("collects every request sample with its client id", () => {
    const clients = [
      "curl",
      "node-fetch",
      "node-xhr",
      "python-requests",
      "python-httpx",
      "go",
    ];
    const blocks = clients
      .map((client) =>
        [
          `<ApiRequestExample client="${client}" lang="bash" label="Request">`,
          "",
          "```bash",
          client,
          "```",
          "",
          "</ApiRequestExample>",
        ].join("\n")
      )
      .join("\n\n");
    const document = parseRuntimeMdx(
      [
        "---",
        "title: Request samples",
        "description: Request samples",
        "---",
        "",
        '<ApiEndpoint method="GET" path="/health">',
        "",
        blocks,
        "",
        "</ApiEndpoint>",
      ].join("\n")
    );

    expect(
      splitEndpointDocument(document).request.map((sample) => sample.client)
    ).toEqual(clients);
  });

  test("collects every response sample in document order", () => {
    expect(endpoint.responses.map((response) => response.status)).toEqual([
      "201",
      "404",
    ]);
    expect(endpoint.responses[0].detail).toBe("application/json");
    expect(endpoint.responses[1].text).toContain("not_found");
  });

  test("collects parameter definitions across every group", () => {
    expect(endpoint.parameters).toEqual([
      {
        name: "projectId",
        type: "string",
        location: "path",
        required: true,
      },
      { name: "key", type: "string", location: "body", required: true },
    ]);
  });

  test("removes the samples from the content and keeps the groups", () => {
    const text = endpoint.content.nodes.map(nodeText).join("\n");

    expect(text).toContain("Create a feature flag under an existing project.");
    expect(text).toContain("Identifier of the project.");
    expect(text).not.toContain("curl --request POST");
    expect(text).not.toContain("not_found");
  });

  test("keeps the frontmatter with the content", () => {
    expect(endpoint.content.frontmatter.apiMethod).toBe("POST");
    expect(endpoint.content.frontmatter.apiPath).toBe(
      "/v1/projects/{projectId}/flags"
    );
  });

  test("returns empty parts for a page with no endpoint block", () => {
    const plain = splitEndpointDocument(
      parseRuntimeMdx("---\ntitle: t\ndescription: d\n---\n\nJust prose.\n")
    );

    expect(plain.baseUrl).toBeUndefined();
    expect(plain.request).toEqual([]);
    expect(plain.responses).toEqual([]);
    expect(plain.parameters).toEqual([]);
    expect(plain.content.nodes).toHaveLength(1);
  });
});

describe("endpointPathSegments", () => {
  test("marks path parameters", () => {
    expect(endpointPathSegments("/v1/projects/{projectId}/flags")).toEqual([
      { value: "v1", parameter: false },
      { value: "projects", parameter: false },
      { value: "{projectId}", parameter: true },
      { value: "flags", parameter: false },
    ]);
  });

  test("handles a root path", () => {
    expect(endpointPathSegments("/")).toEqual([]);
  });
});
