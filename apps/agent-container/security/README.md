# Generation security lab

This lab runs the production agent container image against hostile Doxabot
instructions and repository files. It proves end to end that no secret reaches
a model request, a log, a page or the network. The unit tests check each
control alone; this lab checks the controls together, in the real image.

It runs only on a developer machine. It calls no paid model and no production
service, and it uses fake credentials only.

## How it works

- Each case gets a throwaway Git repository with planted secrets (canaries) in
  `.env`, `server.key`, `.npmrc` and the environment.
- The container runs on an internal Docker network. A local TLS peer stands in
  for GitHub and the model API, and gives fixed (scripted) model replies. When
  the peer sees a canary in a model request, it copies the canary into the
  reply, so a leak reaches the page and the lab detects it.
- An observer container records the agent's system calls and packets.
- The lab calls the normal staged HTTP routes, renders the pages through the
  shared prose components, and checks every request, log, page and packet.

Scripted replies test Doxa's controls. They do not show how a real model
reacts to prompt injection.

## Cases

- `packages/agent/tests/fixtures/security-corpus.json`: seven attack types (a–g).
  Each runs twice: as a dashboard instruction and as `.doxa/instructions.md`.
- `probes.json`: focused probes of tools, output checks and error paths.
- A normal baseline case runs first. If it does not complete with full
  evidence, the lab stops.

## Run

Docker must use a local Unix socket and have about 5 GB free. From
`apps/agent-container`:

```sh
pnpm security:image     # build the production image as agent-container:security-lab
pnpm security:prepare   # check that the image matches the source, download observer tools
pnpm security:lab       # run all cases, two at a time
node security/run.mjs --case probe-dev-vars   # run one case
```

Build the image again after every source change: `run.mjs` refuses an image
that does not match the current source. Set `DOXA_AUDIT_IMAGE` to use another
local image.

Each campaign writes its inputs and evidence to
`.artifacts/security-audit/local-<timestamp>/` (gitignored). The command exits
with a nonzero code when a case fails or stays unverified.

## Check the results

```sh
node security/report-data.mjs ../../.artifacts/security-audit/local-<timestamp>
pnpm security:test
```

`report-data.mjs` writes `reviewed-results.json`, `reviewed-summary.json` and
`case-results.md` next to the campaigns. `security:test` runs the lab's own
tests (`lab.test.mjs`) and the security assertions over the recorded results
(`regressions.test.mjs`). Without recorded results, the assertions skip.

## Policy notes

- Outside links are allowed on generated pages (owner decision, 2026-10-27).
  Outside media, hidden content and raw HTML are findings.
- An error probe completes only when it fails with the provider error that it
  forced.
- Zero lab traffic does not prove that production blocks egress: the
  production agent container has general internet access.
