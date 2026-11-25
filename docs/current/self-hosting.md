# Running your own production

This repo holds the code. It does not hold any operator's production setup:
no account IDs, no Terraform state or variables, and no deploy workflow with
production secrets. An operator keeps those in a private **ops repo** and
deploys one commit of this repo from there. Doxa runs its own production
this way.

```
this repo (public)                 your ops repo (private)
  code, tests, CI                    terraform variables + backend
  Wrangler configs with ${CF_*}  ◀─  Cloudflare ID values
  Terraform modules + root           deploy workflows + secrets
  deploy scripts                     runbook
            ▲                                 │
            └──── checkout at one commit ─────┘──▶ Cloudflare, AWS
```

## What the ops repo holds

| File | Purpose | Template in this repo |
|---|---|---|
| A Cloudflare ID values file, for example `wrangler/production-ids.json` | One JSON object of `CF_*` names to the IDs of your KV namespaces, Hyperdrive configs, zone and VPC Service | `node scripts/apply-production-ids.mjs --list` prints the names that the configs need |
| Terraform variables | The production API stack on AWS: plain API variables, secret names, sizes, alerts | `infra/terraform/production/terraform.tfvars.example` |
| Terraform backend | Your state bucket | `infra/terraform/production/backend.hcl.example` |
| Deploy workflows | They check out this repo at a commit, fill the IDs, validate, test and deploy | the steps of `scripts/deploy-production.mjs` |

Names that the code chooses (Worker names, R2 buckets, queues, domains) stay
in the Wrangler configs. Account-issued IDs are `${CF_*}` placeholders, and
other operator values that do not belong in public, such as the admin
emails, are `${OPS_*}` placeholders. A test,
`scripts/apply-production-ids.test.mjs`, fails if a config gets a real ID or
a personal email address.

Provider account values are `${OPS_*}` placeholders too:

| Placeholder | Config | Value |
|---|---|---|
| `OPS_POSTHOG_PROJECT_KEY` | `apps/mcp/wrangler.json` (`POSTHOG_KEY`), `apps/web/wrangler.json` (`POSTHOG_KEY`) | Your PostHog project key (`phc_…`). The MCP Worker sends its server events to PostHog US Cloud; the web Worker hands the key to the browser. |
| `OPS_POSTHOG_INGEST_HOSTNAME` | `apps/web/wrangler.json` (`POSTHOG_INGEST_HOSTNAME`) | A bare hostname, without `https://`: your PostHog managed reverse proxy, or `us.i.posthog.com`. The browser sends its events there. |

The fill step refuses an empty value. To run without analytics, remove these
variables from the configs in your deploy checkout. The API Node origin reads
`POSTHOG_KEY` from its own environment (Terraform `api_environment`), never
from a Wrangler config.

## Deploy

In a fresh checkout of this repo at the commit to deploy:

```sh
pnpm install --frozen-lockfile
node scripts/apply-production-ids.mjs --values <ops>/wrangler/production-ids.json
pnpm validate:production-config
node scripts/deploy-production.mjs          # every step; --list prints them
```

- `apply-production-ids.mjs` changes the configs in place. Run it in a deploy
  checkout, never in a working tree.
- `deploy-production.mjs` and `deploy-api.mjs` refuse configs that still hold
  a placeholder.
- The API deploys as two parts: the Node origin on ECS, then the thin edge
  Worker. See [api-node-origin.md](api-node-origin.md).
- Your workflow can check that it follows the step order of the script:
  `DOXA_DEPLOY_WORKFLOW=<path to your workflow> node --test scripts/deploy-production.test.mjs`.

## Terraform

Run the root module `infra/terraform/production` with your variables and
backend:

```sh
terraform -chdir=infra/terraform/production init -backend-config=<ops>/terraform/backend.hcl
terraform -chdir=infra/terraform/production plan -var-file=<ops>/terraform/production.tfvars
```

`github_repositories` lists the repos whose `production` environment may
take the AWS deploy role through OIDC: your ops repo. See
[`infra/terraform/README.md`](../../infra/terraform/README.md) for the
resources, the first apply and the secrets.

## Secrets

The API origin reads its secrets from AWS SSM. Write them with the names in
your variables file:

```sh
bash scripts/api-origin-secrets.sh --tfvars <ops>/terraform/production.tfvars
```
