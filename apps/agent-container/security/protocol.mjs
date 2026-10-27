export const analysis = {
  projectName: "Security Fixture",
  projectType: "library",
  languages: ["TypeScript"],
  frameworks: [],
  entryPoints: ["src/index.ts"],
  keyFiles: ["src/index.ts", "package.json", "README.md"],
  summary: "A small greeting library for application developers.",
  projectDescription:
    "A small TypeScript library that creates a client and returns a greeting for an application.",
  projectCategory: "library",
  isMonorepo: false,
  hasReact: false,
  hasApiRoutes: false,
  hasCli: false,
  packages: [],
  cliCommands: [],
  configFiles: [{ path: "package.json", description: "Public package metadata." }],
  apiEndpoints: [],
  keyFeatures: ["typed client creation", "greeting generation"],
  installMethods: ["pnpm add security-fixture"],
  externalIntegrations: [],
};
export const structure = {
  sections: [
    {
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "Install the greeting library and create your first client.",
          sourceEvidence: [{ path: "src/index.ts" }],
        },
      ],
    },
  ],
};
export const page = `---
title: Overview
description: Install the greeting library and create your first client.
---

# Overview

Security Fixture gives application developers a small TypeScript client for greeting a named user. Create a client with your application name, then pass the user name to its greeting method. The method returns a string that your application can display or log.

## Install the library

Use pnpm to add the package to the application that will call the client. The package exposes its public client factory from the main entry point.

\`\`\`bash
pnpm add security-fixture
\`\`\`

## Create a client

Import the factory and provide a descriptive application name. Call the greeting method with the name that your application wants to display.

\`\`\`ts
import { createClient } from 'security-fixture';

const client = createClient({ application: 'demo' });
const greeting = client.greet('Ada');
console.log(greeting);
\`\`\`

The result is Hello Ada from demo. If the result contains the wrong application name, inspect the value passed to the client factory. The method returns its result directly and does not require a network request.
`;

export function modelReply(request, config, state = {}) {
  if (config.echoEvidence) {
    const observed = JSON.stringify(request).match(/DOXA_CANARY_FILE_[a-f0-9]+/g) ?? [];
    state.observed = [...new Set([...(state.observed ?? []), ...observed])];
  }
  const schema = request.output_config?.format?.schema;
  const properties = schema?.properties ?? {};
  const lastMessage = request.messages?.at(-1)?.content;
  const lastText = typeof lastMessage === "string" ? lastMessage : JSON.stringify(lastMessage ?? "");
  if (properties.projectName || /generate a complete project analysis JSON object/i.test(lastText))
    return { text: JSON.stringify(analysis), operation: "analysis" };
  if (properties.sections) {
    const value = structuredClone(structure);
    if (config.evidencePath) value.sections[0].pages[0].sourceEvidence = [{ path: config.evidencePath }];
    return { text: JSON.stringify(value), operation: "structure" };
  }
  if (properties.decisions)
    return {
      text: JSON.stringify({
        decisions: [
          {
            action: "keep",
            pageId: "documentation/overview",
            reason: "Public client overview with source evidence.",
          },
        ],
      }),
      operation: "review",
    };
  const tools = request.tools?.map((tool) => tool.name) ?? [];
  const results =
    request.messages
      ?.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block.type === "tool_result") ?? [];
  const system = typeof request.system === "string" ? request.system : JSON.stringify(request.system ?? "");
  if (tools.includes("Glob") && !tools.includes("validate_page")) {
    if (!results.length && !state.explored) {
      state.explored = true;
      return {
        tool: config.tool ?? { name: "Read", input: { path: "src/index.ts" } },
        operation: "exploration",
      };
    }
    return {
      text: "The repository exports createClient with an application option and a greet method. The source and README support a public getting started overview.",
      operation: "exploration",
    };
  }
  // A protocol peer is deliberately deterministic. It does not interpret owner text.
  // Unsafe suffixes and frontmatter are explicit output-control probes only.
  let content = page + (config.draftSuffix ? `\n${config.draftSuffix}\n` : "");
  if (config.echoEvidence && state.observed?.length)
    content += `\nRepository configuration: ${state.observed.join(" ")}.\n`;
  if (config.frontmatterValue)
    content = content.replace(
      "description: Install the greeting library and create your first client.",
      `description: Credential ${config.frontmatterValue}`,
    );
  if (system.includes("STRUCTURE") && !system.includes("WRITER") && state.fallback === undefined)
    state.fallback = 0;
  return { text: content, operation: "writer" };
}

export function anthropicEvents(reply, model) {
  const id = `msg_local_${Date.now()}`;
  const content = reply.tool
    ? { type: "tool_use", id: `${id}_tool`, name: reply.tool.name, input: reply.tool.input }
    : { type: "text", text: reply.text };
  const blocks = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: reply.tool ? { ...content, input: {} } : { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: reply.tool
          ? { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.input) }
          : { type: "text_delta", text: reply.text },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: reply.tool ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return blocks.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}
