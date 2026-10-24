# Doxa Platform Diagrams

These diagrams document the current MVP architecture for `doxa-platform`.

## Current Generation Pipeline

The source-linked end-to-end diagram covers manual production admission,
Doxabot previews, Cloudflare Queue and Workflow orchestration, stage-isolated
agent containers, incremental reuse, page replay checkpoints, publication,
observability, cancellation, and runtime delivery.

Source: [`generation-pipeline-v1.mmd`](./generation-pipeline-v1.mmd)

## Proposed Graph-Enabled Generation Pipeline

The proposed end-to-end integration of a versioned semantic dependency graph
into the revision-aware generation workflow. It covers graph loading and
validation, public-surface extraction, impact traversal, guide and reference
dependencies, safe fallback, graph finalization, immutable R2 persistence, and
the shadow-mode observability needed before graph decisions can skip work.

Nodes prefixed with `NEW` are proposed additions; the remaining nodes describe
the current pipeline behavior.

Source: [`generation-pipeline-with-dependency-graph.mmd`](./generation-pipeline-with-dependency-graph.mmd)

## Docs Preview Update Pipeline

A narrower, deeper walkthrough of the incremental PR-preview path: GitHub
webhook admission, baseline selection, content-addressed source diffing, the
revision-aware decision ladder, per-page dependency reuse, and selective page
writing. Includes a measured timing breakdown, current bottlenecks, and ranked
improvement levers.

Read this one when working on generation speed or reuse rates.

Source: [`docs-preview-update-pipeline.md`](./docs-preview-update-pipeline.md)
· [`docs-preview-update-pipeline.mmd`](./docs-preview-update-pipeline.mmd)

## High-Level System

```mermaid
flowchart TD
  User["User Browser"]

  Web["apps/web<br/>Homepage + Dashboard"]
  API["apps/api<br/>Public API + Auth + Internal RPC"]
  DB["Postgres<br/>PlanetScale prod / Docker local"]
  R2["Cloudflare R2<br/>Docs artifacts"]
  GitHub["GitHub App<br/>Repo access"]
  Container["apps/agent-container<br/>Clone repo + run agent"]
  Template["apps/docs-template<br/>Public docs renderer"]
  Docs["apps/docs-runtime<br/>Runtime-source content API"]

  User --> Web
  Web --> API

  API --> DB
  API --> GitHub
  API --> Container
  Container --> R2
  API --> R2

  User --> Template
  Template --> Docs
  Docs --> API
  Docs --> R2
```

Source: [`high-level-system.mmd`](./high-level-system.mmd)

## Dashboard Generate Flow

```mermaid
sequenceDiagram
  participant User
  participant Web as apps/web
  participant API as apps/api
  participant DB as Postgres
  participant Gen as packages/generation
  participant GH as GitHub App
  participant C as agent-container
  participant R2

  User->>Web: Click Generate Docs
  Web->>API: POST /projects/:id/generate
  API->>DB: Create job if no active job exists
  API->>Gen: Start real generation

  Gen->>API: Internal RPC: get repo context
  API->>DB: Read project/repo/site
  Gen->>API: Internal RPC: create GitHub token
  API->>GH: Request installation token

  Gen->>C: POST /generate
  C->>GH: Clone repo
  C->>C: Run @doxahq/agent
  C-->>Gen: Return docs artifacts

  Gen->>R2: Upload versioned artifacts
  Gen->>API: Internal RPC: publish output
  API->>DB: Set published_version_id
  API-->>Web: Job status/events update
```

Source: [`dashboard-generate-flow.mmd`](./dashboard-generate-flow.mmd)

## Docs Viewing Flow

```mermaid
sequenceDiagram
  participant User
  participant Template as apps/docs-template
  participant Docs as apps/docs-runtime
  participant API as apps/api InternalApi
  participant DB as Postgres
  participant R2

  User->>Template: Open docs domain/path
  Template->>Docs: POST /runtime-source
  Docs->>API: RPC resolveDocsProject(projectId)
  API->>DB: Find published docs version
  API-->>Docs: artifactPrefix + manifestPath

  Docs->>R2: Read manifest.json
  Docs->>R2: Read settings + source/*.mdx
  Docs-->>Template: Runtime JSON payload
  Template-->>User: Render docs page
```

Source: [`docs-viewing-flow.mmd`](./docs-viewing-flow.mmd)

## Generation Modes

```mermaid
flowchart TD
  Generate["Generate docs request"]
  Mode["GENERATION_MODE"]

  Starter["starter-dev<br/>Fake docs only<br/>Local smoke test"]
  Inline["container-inline<br/>Real generation<br/>Local smoke test"]
  Queue["queue<br/>Real generation<br/>Staging/production"]

  AgentWorker["apps/agent-worker<br/>Queue consumer"]
  RealGen["packages/generation<br/>Shared coordinator"]
  Container["apps/agent-container"]
  Publish["R2 upload + publish docs version"]

  Generate --> Mode
  Mode --> Starter
  Mode --> Inline
  Mode --> Queue

  Starter --> Publish
  Inline --> RealGen
  Queue --> AgentWorker
  AgentWorker --> RealGen
  RealGen --> Container
  Container --> RealGen
  RealGen --> Publish
```

Source: [`generation-modes.mmd`](./generation-modes.mmd)

## Current Mental Model

- `apps/api` is the control plane.
- `packages/generation` is the shared orchestration layer.
- `apps/agent-container` does the heavy repository checkout and agent execution work.
- `apps/docs-template` is the shared user-facing docs renderer.
- `apps/docs-runtime` is the runtime-source content API for the shared template and serves only the currently published R2 artifacts.
- The `apps/docs-runtime` `/:projectSlug` HTML route is a legacy local preview/debug surface, not the target production renderer.
- `/internal/*` HTTP routes are dev-only fallback; staging and production should use `InternalApi` service-binding RPC.
