import { createServer } from "node:https";
import { readFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { modelReply, anthropicEvents } from "./protocol.mjs";

const config = JSON.parse(readFileSync("/fixture/config.json", "utf8"));
const state = {};
let sequence = 0;
const log = (entry) =>
  appendFileSync("/evidence/peer.jsonl", `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const server = createServer(
  { key: readFileSync("/fixture/server.key"), cert: readFileSync("/fixture/server.crt") },
  async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const host = (request.headers.host ?? "").split(":")[0];
      if (host === "github.com") {
        log({
          kind: "git",
          method: request.method,
          path: request.url,
          authenticated: Boolean(request.headers.authorization),
        });
        if (!request.headers.authorization) {
          response.writeHead(401, { "www-authenticate": 'Basic realm="local-fixture"' });
          response.end();
          return;
        }
        const url = new URL(request.url, "https://github.com");
        if (!url.pathname.startsWith("/local/security-fixture.git/")) {
          response.writeHead(404);
          response.end();
          return;
        }
        const child = spawn("git", ["http-backend"], {
          env: {
            PATH: process.env.PATH,
            GIT_PROJECT_ROOT: "/fixture/repos",
            GIT_HTTP_EXPORT_ALL: "1",
            REQUEST_METHOD: request.method,
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: request.headers["content-type"] ?? "",
            CONTENT_LENGTH: String(body.length),
            REMOTE_USER: "local-test",
            ...(request.headers["git-protocol"]
              ? { HTTP_GIT_PROTOCOL: request.headers["git-protocol"] }
              : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const output = [];
        const errors = [];
        child.stdout.on("data", (data) => output.push(data));
        child.stderr.on("data", (data) => errors.push(data));
        child.on("close", (code) => {
          const raw = Buffer.concat(output);
          const end = raw.indexOf("\r\n\r\n");
          if (end < 0) {
            log({ kind: "git-error", code, error: Buffer.concat(errors).toString() });
            response.writeHead(500);
            response.end("Git fixture failed");
            return;
          }
          const headers = {};
          let status = 200;
          for (const line of raw.subarray(0, end).toString().split("\r\n")) {
            const separator = line.indexOf(":");
            if (separator < 0) continue;
            const key = line.slice(0, separator).toLowerCase();
            const value = line.slice(separator + 1).trim();
            if (key === "status") status = Number.parseInt(value);
            else headers[key] = value;
          }
          response.writeHead(status, headers);
          response.end(raw.subarray(end + 4));
        });
        child.stdin.end(body);
        return;
      }
      if (
        host === "api.anthropic.com" &&
        new URL(request.url, "https://api.anthropic.com").pathname === "/v1/messages"
      ) {
        const input = JSON.parse(body.toString());
        // Auth headers are expected credential transport, never a diagnostic sink.
        log({
          kind: "model-request",
          sequence: ++sequence,
          body: input,
          authPresent: Boolean(request.headers.authorization || request.headers["x-api-key"]),
        });
        const reply = modelReply(input, config, state);
        log({
          kind: "model-reply",
          sequence,
          operation: reply.operation,
          ...(reply.tool ? { tool: reply.tool } : { text: reply.text }),
        });
        if (config.rejectCredentialAt === reply.operation) {
          const credential = String(
            request.headers.authorization ?? request.headers["x-api-key"] ?? "",
          ).replace(/^Bearer\s+/i, "");
          response.writeHead(401, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "authentication_error",
                message: `Local model fixture rejected credential ${credential}`,
              },
            }),
          );
          return;
        }
        if (input.stream) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.end(anthropicEvents(reply, input.model));
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: `msg_${sequence}`,
              type: "message",
              role: "assistant",
              model: input.model,
              content: reply.tool
                ? [{ type: "tool_use", id: `tool_${sequence}`, ...reply.tool }]
                : [{ type: "text", text: reply.text }],
              stop_reason: reply.tool ? "tool_use" : "end_turn",
              usage: { input_tokens: 10, output_tokens: 20 },
            }),
          );
        }
        return;
      }
      log({ kind: "unexpected-request", host, method: request.method, path: request.url });
      response.writeHead(403);
      response.end("Destination is outside this fixture.");
    } catch (error) {
      log({ kind: "peer-error", error: error.message });
      response.writeHead(500);
      response.end("Local fixture error.");
    }
  },
);
server.listen(443, "0.0.0.0", () => {
  log({ kind: "peer-ready" });
  console.log("Local TLS peer ready");
});
