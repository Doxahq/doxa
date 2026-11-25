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
- Zero lab traffic does not prove that production blocks egress. The lab
  runs the image on plain Docker, without the Workers runtime, so the egress
  gate (`src/egress.ts`) does not run here. See "Egress allow list" below.

## Egress allow list

In production, the Worker intercepts every HTTP and HTTPS request of the agent
container (`AgentContainer.outbound` in `src/worker.ts`). `AGENT_EGRESS_MODE`
on the `doxa-agent-container` Worker sets what the gate does:

- `log`: forward everything, and log each
  host once per run (`eventType: "agent_egress"`, `listed: false` for a host
  that `enforce` would refuse).
- `enforce`: the container has no direct internet. Only `github.com`,
  `api.anthropic.com`, `openrouter.ai` and the hosts in
  `AGENT_EGRESS_ALLOWED_HOSTS` are forwarded, over HTTPS only. Other requests
  get 403 with `x-doxa-egress: refused` and log `agent_egress_refused`.
- `off` (default, and any unknown value): the behavior before the gate. A deploy changes nothing until the mode is set.

The unit tests (`tests/egress.test.ts`) check the decision and the gate. They
also check that the hosts this lab stands in for (`allowedHosts` in
`run.mjs`) are on the allow list.

The lab cannot check `enforce` end to end, because the gate runs only in the
Cloudflare runtime. Check it by hand on a staging deploy of the agent
container, never on production first:

1. Deploy with `AGENT_EGRESS_MODE=log`. Run one generation. In the Worker logs,
   find the `agent_egress` lines of the run: every host must have
   `listed: true`, and the run must complete (this also proves that Node and
   git trust the egress CA, `scripts/trust-egress-ca.sh`).
2. Set `AGENT_EGRESS_MODE=enforce` and deploy again. Run one generation: it
   must complete.
3. Run the probe in the same container while a run holds it (or in a test
   build): `node -e "fetch('https://example.com').then(r=>console.log(r.status, r.headers.get('x-doxa-egress')))"`.
   It must print `403 refused`, and the Worker logs must show
   `agent_egress_refused` with `host: "example.com"`. Also check that
   `node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>console.log('open')).on('error',e=>console.log(e.code))"`
   does not print `open`: raw TCP must not leave without the gate.
