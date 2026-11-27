# API on ECS Fargate — Terraform

An operator runs this stack from a private ops repo, with its own variables,
backend and deploy workflows: see
[`docs/current/self-hosting.md`](../../docs/current/self-hosting.md).

This folder creates the AWS and Cloudflare resources that run the Doxa API as a
Node server on ECS Fargate. The API runs as two ECS services, blue and green,
each with its own private Cloudflare Tunnel and Workers VPC Service. The thin
`doxa-api` Worker stays on Cloudflare and calls the live color through its
`ORIGIN_BLUE` or `ORIGIN_GREEN` binding (`ORIGIN_COLOR` names it). Between
releases the other color runs no task.

```
caller Workers ─RPC─▶ doxa-api Worker ─ORIGIN_<COLOR> binding (Workers VPC)─┐
                                                                    │ private tunnel,
AWS us-east-1 · VPC with public subnets, no NAT                     ▼ no public hostname
┌ Fargate task, 2 vCPU / 4 GB, ARM64 ──────────────────────────────┐
│  cloudflared ──localhost:8786──▶ api (Node)                       │
└───────────────────────────────────────┬──────────────────────────┘
                                        ▼
            PlanetScale Postgres · R2 (S3 API) · ElastiCache Serverless Valkey
```

The origin has no public hostname and no DNS record. Nothing on the internet
can send it a request:

- The task has no load balancer, and its security group allows no inbound
  traffic. `cloudflared` opens the tunnel from inside the task.
- The tunnel has no public hostname. Its only ingress rule answers 404.
- Only Workers of the Cloudflare account with a binding to the VPC Service can
  send requests into the tunnel. The origin also checks the origin key on
  every request.

## Layout

| Path | What it creates |
|---|---|
| `production/` | The root stack. It joins the modules, writes the tunnel token to SSM and holds the state backend. |
| `modules/network` | A VPC with 2 public subnets, an internet gateway and no NAT gateway. |
| `modules/container-registry` | The `doxa-api` ECR repository: immutable tags, scan on push, keeps the last 30 images. |
| `modules/cloudflare-tunnel` | The private tunnel (no public hostname, a 404-only ingress rule) and the Workers VPC Service to `127.0.0.1:8786` in the task. |
| `modules/valkey` | ElastiCache Serverless for Valkey, with usage caps. Only the API tasks can connect. |
| `modules/api-service` | The cluster, the task definition (api + cloudflared), the service, IAM roles, logs and CPU autoscaling. |
| `modules/github-deploy` | A GitHub Actions OIDC role that can push images and deploy the service, and nothing else. Only jobs in the `production` GitHub environment can take it. |
| `modules/monitoring` | Email alerts: no running task, high CPU or memory, failed deploys, and the monthly budget. |

## Monthly cost

| Item | Cost |
|---|---|
| Fargate task, 2 vCPU / 4 GB, ARM64, 24/7 | ≈ $57.70 |
| 1 public IPv4 | ≈ $3.65 |
| ElastiCache Serverless Valkey (100 MB minimum) | ≈ $6.10 |
| CloudWatch Logs + ECR | ≈ $1–2 |
| Cloudflare Tunnel, Workers VPC (free in beta) | $0 |
| **Total** | **≈ $69** |

Each extra task adds ≈ $61. Do not add a NAT gateway (≈ $33 a month): the
tasks use public IPs for outbound traffic.

## Before the first apply

1. Install Terraform 1.10 or later. Without a local install, use
   `docker run --rm -v "$PWD":/tf -w /tf/production hashicorp/terraform:1.17.0 <command>`.
2. Use AWS credentials that can manage VPC, ECS, ECR, IAM, SSM, ElastiCache,
   CloudWatch, SNS, EventBridge and Budgets.
3. Create a Cloudflare API token for the Doxa account with these account
   permissions, and export it as `CLOUDFLARE_API_TOKEN`:
   - **Cloudflare Tunnel · Edit**;
   - **Connectivity Directory** at its write (admin) level, for the Workers
     VPC Service.

   The stack needs no zone permission: it creates no DNS record. The token
   that deploys the thin Worker needs the Connectivity Directory bind level.
4. Create the state bucket once:

   ```sh
   aws s3api create-bucket --bucket doxa-terraform-state-<account-id> --region us-east-1
   aws s3api put-bucket-versioning --bucket doxa-terraform-state-<account-id> \
     --versioning-configuration Status=Enabled
   aws s3api put-public-access-block --bucket doxa-terraform-state-<account-id> \
     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```

5. In your ops repo, make a backend file from `production/backend.hcl.example`
   and a variables file from `production/terraform.tfvars.example`, and fill
   in the values. Neither belongs in this repo. Set `github_repositories` to
   the repo that runs your deploy workflows.

The state holds the tunnel token. Keep the bucket private and versioned.

## First apply

The service needs an image before it can start, so the first apply runs in
three parts.

Pass your files to every command: `init -backend-config=<ops>/backend.hcl`,
and `plan` or `apply` with `-var-file=<ops>/production.tfvars`. The commands
below leave these flags out.

```sh
cd infra/terraform/production
terraform init -backend-config=<ops>/backend.hcl

# 1. Create the image repository only.
terraform apply -target=module.container_registry

# 2. Build and push the first image (an ARM64 image of the Node API).
REPO=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO%%/*}"
docker buildx build --platform linux/arm64 -f apps/api/Dockerfile -t "$REPO:$(git rev-parse --short=12 HEAD)" --push ../../..

# 3. Write every secret in api_secret_names (see "Secrets" below), then apply the rest.
(cd ../../.. && pnpm secrets:api:ecs --tfvars <ops>/production.tfvars)
terraform apply
```

After the apply:

- Open the confirmation email that AWS sends to each `alert_emails` address.
  Alerts reach only confirmed addresses.
- The first task can log `Valkey connection error ... ETIMEDOUT` for about a
  minute: the ElastiCache endpoints finish after the cache shows `available`.
  The client reconnects by itself.
- Put the two IDs of `terraform output origin_vpc_service_ids` in the values
  file of the ops repo, as `CF_API_ORIGIN_BLUE_VPC_SERVICE_ID` and
  `CF_API_ORIGIN_GREEN_VPC_SERVICE_ID` (the `ORIGIN_BLUE` and `ORIGIN_GREEN`
  bindings of `apps/api-edge/wrangler.json`).
- Check the path before the cutover. Deploy the thin Worker to a test name
  with `ORIGIN_COLOR=blue`, and request `/health` through it. The answer must
  be `{"ok":true,"service":"doxa-api"}`. Workers VPC is in beta, and this
  check is the first one that runs against the real tunnel.

### Move a single-service stack to blue/green

A stack from before blue/green has one service, one tunnel and one VPC
Service. The `moved` blocks make them blue in place, with the same names, so
the apply creates only green: its service with no task, its task family, its
tunnel, its VPC Service, its `TUNNEL_TOKEN_GREEN` parameter, and the
`deploy/task-count` parameter. `terraform plan` must show no replacement.

1. `terraform apply`.
2. In the values file, rename `CF_API_ORIGIN_VPC_SERVICE_ID` to
   `CF_API_ORIGIN_BLUE_VPC_SERVICE_ID` (same value), and add
   `CF_API_ORIGIN_GREEN_VPC_SERVICE_ID` from `origin_vpc_service_ids.green`.
3. Release. The live edge has no `ORIGIN_COLOR`, so the release reads it as
   blue and starts the new image on green.

## Secrets

The API secrets live in SSM Parameter Store at `/doxa/api/production/<NAME>`
as SecureString. Terraform stores only their names (`api_secret_names`), and
the ECS task reads the values when it starts. A task cannot start while one of
them is missing.

Write them with the secrets script from the repo root. It reads the names from
`api_secret_names`, asks only for the missing ones, hides what you type and
never prints a value:

```sh
pnpm secrets:api:ecs --tfvars <ops>/production.tfvars --list             # set or missing; changes nothing
pnpm secrets:api:ecs --tfvars <ops>/production.tfvars                    # ask for each missing secret
pnpm secrets:api:ecs --tfvars <ops>/production.tfvars --overwrite NAME   # replace only NAME (repeat for more); skips the others
```

| Secret | Where to get it |
|---|---|
| `ORIGIN_SHARED_SECRET`, `BRIDGE_SHARED_SECRET` | The script generates them. Copy each to the edge Worker with the command that it prints. |
| `DATABASE_URL` | The PlanetScale connection string, the same database that the Hyperdrive config uses. |
| `BETTER_AUTH_SECRET` | The value of the production API Worker. A new value signs out every user. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud console → APIs & Services → Credentials → the Doxa OAuth client. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | GitHub → Settings → Developer settings → GitHub Apps → the production Doxa app. |
| `GITHUB_APP_PRIVATE_KEY` | The same page → Private keys → Generate a private key. The script asks for the path of the downloaded `.pem`. Delete the file after. |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys. |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with **Zone · SSL and Certificates · Edit** on the `doxa.page` zone only, for custom hostnames. Not the Terraform token. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 → Manage API tokens → an account token with **Object Read & Write** on `doxa-docs-artifacts-enam` only. |

Never paste a secret into a chat, a ticket or a shell command. If one leaks,
rotate it at its source and run the script with `--overwrite`.

## Deploy

A production deploy is a release (see
[`docs/current/production-release.md`](../../docs/current/production-release.md)).
Its `api` step runs `scripts/deploy/deploy-api.mjs --stage`:

1. It reads the live color from the edge version that serves traffic.
2. `scripts/deploy/deploy-api-ecs.mjs` registers a revision of the idle color's task
   family with the new image, gives that color the task count of the
   `deploy/task-count` parameter, and waits until its tasks are healthy and
   cloudflared joined its tunnel.
3. It uploads an edge version that names the idle color. The release flip
   serves that version, and the traffic moves to the new color.

The old color keeps running through the watch step of the release (15
minutes), so a rollback is instant. Then the release stops it (0 tasks).

The operator's deploy workflows run in the ops repo (see
`docs/current/self-hosting.md`):

- They take the deploy role through OIDC. The role trusts only the
  `production` environment of the repos in `github_repositories`.
- **Required GitHub setting:** limit that `production` environment to the
  `main` branch (Settings → Environments → production → Deployment
  branches). Otherwise a job on another branch could take the role with a
  changed workflow.
- They need two variables on that environment, both from `terraform output`:
  `AWS_API_DEPLOY_ROLE_ARN` (`github_deploy_role_arn`) and
  `AWS_API_ECR_REPOSITORY_URL` (`ecr_repository_url`).
- The image is ARM64. Build it on an ARM64 runner (`ubuntu-24.04-arm`), or on
  `ubuntu-latest` with `docker/setup-qemu-action`.
- Their Cloudflare token needs the Connectivity Directory bind permission,
  for the edge's `ORIGIN_BLUE` and `ORIGIN_GREEN` bindings.

By hand, one color at a time (the edge does not change):

```sh
pnpm deploy:api:ecs --color green --image <ecr_repository_url>:<git-sha>   # start an image on green
pnpm deploy:api:ecs --color blue --revision <task-definition-arn>          # start a revision on blue
pnpm deploy:api:ecs --retire blue                                          # stop blue
```

Within a color, ECS starts the new task, waits for its health check and then
stops the old task. If the new task keeps failing, the circuit breaker
restores the old revision, and the script exits with an error.

Terraform does not change the running revision or the task count of a color.
A Terraform change to the task definition (size, environment, secrets)
registers a new revision, and the next deploy ships it. A change of
`min_task_count` or `max_task_count` updates the `deploy/task-count`
parameter, and the next deploy applies it to the color that it starts.

`--env NAME=VALUE` sets a plain variable on the new revision. The release
sets `DOXA_RELEASE_ID` and `DOXA_RENDERER_RELEASE_ID` with it. A Terraform
revision does not hold `DOXA_RENDERER_RELEASE_ID`, so a deploy that does not
set it keeps the value of the live color's revision (`DEPLOY_VARIABLES` in
`scripts/deploy/lib/ecs-task-definition.mjs`).

## Day to day

| Task | Command or place |
|---|---|
| Read logs | `aws logs tail /ecs/doxa-api-production --follow` (both colors write to this group) |
| Shell into the API | ECS Exec is off by default. Set `enable_execute_command = true`, `terraform apply`, then deploy so a new task starts with it. Run `aws ecs execute-command --cluster doxa-api-production --task <task-id> --container api --interactive --command sh`. Set it back to `false` and apply after the session. |
| Add a secret | Add the name to `api_secret_names`, run `pnpm secrets:api:ecs --tfvars <ops>/production.tfvars`, `terraform apply`, then deploy. |
| Rotate a secret | `pnpm secrets:api:ecs --tfvars <ops>/production.tfvars --overwrite NAME`, then deploy. For the two shared keys, also update the edge Worker (the script prints the command). |
| Change the task size | Set `cpu_units` and `memory_mb`, `terraform apply`, then deploy. |
| Turn on autoscaling | Set `max_task_count` above `min_task_count`, `terraform apply`, then release. Each color scales on 60% average CPU. |
| Update cloudflared | Change `cloudflared_image` in `modules/api-service` to a new pinned tag, `terraform apply`, then deploy. Workers VPC needs cloudflared 2025.7.0 or later and QUIC (outbound UDP 7844). |

## Checks

All checks run offline. Nothing reaches AWS or Cloudflare.

```sh
terraform fmt -check -recursive
(cd production && terraform init -backend=false && terraform validate && terraform test)
(cd modules/api-service && terraform init && terraform test)
(cd modules/cloudflare-tunnel && terraform init && terraform test)
tflint --init && tflint --recursive --config "$PWD/.tflint.hcl"
(cd modules/monitoring && terraform init && terraform test)
node --test scripts/deploy/tests/ecs-task-definition.test.mjs scripts/deploy/tests/deploy-api-ecs.test.mjs scripts/deploy/tests/release.test.mjs   # from the repo root
```
