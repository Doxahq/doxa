# Contributing to Doxa

Thank you for your interest in Doxa. This guide tells you how the repository is organized, how to set it up, and what a pull request must contain before we review it.

## Before you start

- **Small fixes:** a typo, a broken link or a clear bug with a small fix can go straight to a pull request.
- **Large changes:** open an issue first. A new feature, a refactor, a change to a public API, the database schema or the docs artifact format needs an agreed approach before you write code.
- **Security problems:** do not open a public issue. Read [SECURITY.md](SECURITY.md).

## Set up the repository

You need Node.js 24, pnpm 10 and Docker.

```sh
git clone https://github.com/Doxahq/doxa.git
cd doxa
pnpm install

cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.local.example apps/web/.env.local

pnpm db:local:up
pnpm db:local:migrate
pnpm dev
```

Read [docs/development.md](docs/development.md) for the dev flags, the local tunnel and the full generation path. The apps read the workspace packages from their build output, so run `pnpm --filter './packages/**' build` after you change a package.

## Repository layout

A pnpm monorepo in TypeScript.

| Path | What it does |
|---|---|
| `apps/web` | The `doxa.so` website and the dashboard (TanStack Start). |
| `apps/api` | The API: auth, GitHub, projects, generations and publishing. Runs as a Node origin. |
| `apps/api-edge` | The thin Worker in front of the API origin. |
| `apps/mcp` | The MCP server at `mcp.doxa.so`. |
| `apps/docs-template` | The docs site renderer: MDX, navigation, search and API reference. |
| `apps/docs-runtime` | Serves the published content of each project from R2 to the renderer. |
| `apps/docs-dispatcher`, `apps/docs-prerenderer` | Routing and prerendering for docs sites. |
| `apps/agent-worker`, `apps/agent-container` | The generation queue consumer and the container that checks out repositories and runs Doxabot. |
| `apps/search-gateway` | The search gateway for docs sites. |
| `apps/try-proxy` | The proxy for the API playground. |
| `apps/email-worker`, `apps/utility-jobs` | Email and background jobs. |
| `packages/agent`, `packages/generation` | The Doxabot agent and the generation pipeline. |
| `packages/mdx-runtime`, `packages/docs-prose` | The MDX parser and the shared page renderer. |
| `packages/db` | The Drizzle schema and the migrations. |
| `packages/contracts` | The shared API types and Zod schemas. |
| `infra/terraform` | The production infrastructure on AWS. |

The architecture notes for each system are in [docs/current](docs/current).

## Code rules

[AGENTS.md](AGENTS.md) holds the code rules for people and for coding agents. Read it before you change code. The rules that most often block a pull request:

- **Keep package and app boundaries.** Do not import platform internals into the docs renderer, and keep Node-only code under `apps/api/src/runtime/node`.
- **Do not break published docs.** The docs renderer must read every artifact version that Doxa ever wrote. Read [docs/current/docs-artifact-compatibility.md](docs/current/docs-artifact-compatibility.md) before you touch the docs engine, the renderer, the runtime or an artifact writer.
- **Never commit a secret or an account ID.** Wrangler configs hold `${CF_*}` placeholders. Real values live outside this repository.
- **Do not weaken a guardrail test.** A test marked `ARTIFACT COMPATIBILITY GATE` or `PRODUCTION INCIDENT REGRESSION GUARDRAIL` is a contract. If it fails, fix the code, not the test.
- **Use typed contracts.** Use the Zod schemas in `packages/contracts` and the Drizzle schema in `packages/db`, not ad hoc string handling. Do not use `any`.
- **Follow the design system.** UI changes follow [apps/web/DESIGN.md](apps/web/DESIGN.md).

## Check your change

Run the same checks as CI before you open a pull request:

```sh
pnpm validate:production-config
pnpm --filter './packages/**' build
pnpm typecheck
pnpm test
```

Then run the checks that fit your change:

| You changed | Also run |
|---|---|
| The docs engine, renderer or runtime (the read side) | `pnpm --filter @doxahq/docs-artifact-fixtures test`, `pnpm --filter @doxahq/docs-runtime test` and `pnpm --filter @doxahq/docs-template test` |
| Routes, queries or bundling in `apps/web` | `pnpm --filter @doxahq/web build` (it also prerenders every page) |
| A page or a component | Open it in the browser at desktop and phone widths, and add screenshots to the pull request |
| The database schema | `pnpm db:generate` and `pnpm db:check`, and commit the generated migration |
| Behavior in the API, runtime, contracts or generation | Add or update a test that fails without your change |

Tests must be deterministic and run locally. Do not call live services from a test.

## Pull requests

A pull request must answer three questions in its description:

1. **Why:** the problem it solves, with a link to the issue. "Improve the code" is not a reason.
2. **What:** the change in a few sentences. Keep one change in one pull request.
3. **How you checked it:** the commands that you ran and their result, and screenshots for UI changes. If you skipped a check, say which one and why.

We close a pull request without review if it has no clear reason, if it was not run or checked, or if it changes code that it does not need to change.

### AI-assisted work

You can use coding agents. You are still the author, and you must understand every line that you submit.

- **Do not submit unreviewed agent output.** Read the diff yourself before you open the pull request.
- **Check the work with the right tools:** run the tests, open the page and read the logs. The agent's summary is not proof.
- **Keep the diff small and on topic.** No drive-by refactors, renamed files, reformatted code or generated comments that the change does not need.
- **Write the description yourself.** Do not paste an agent's summary. Say what you checked.

Pull requests that look like unchecked AI output get closed. Repeated ones lead to a block.

## Commits

Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org) form, with the area in parentheses. For example: `fix(api): hold the cron lock as a Valkey lease`. Explain why in the body when the reason is not clear from the title.

## License

Doxa is open source under the [Apache License 2.0](LICENSE). When you open a pull request, you agree that your contribution is licensed under the same terms.
