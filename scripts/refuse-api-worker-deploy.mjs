#!/usr/bin/env node
// Stops a deploy of apps/api as a Worker. Since the move to ECS,
// doxa-api-production is the thin edge Worker (apps/api-edge), and the API
// runs as the Node origin. A `wrangler deploy --env production` in apps/api
// would replace the edge with the old full API Worker.
//
// apps/api/wrangler.json runs this script as the build command of its
// production environment, and Wrangler runs a build command before every
// deploy, so the deploy stops before anything is uploaded. Local development
// uses the top-level config and never runs it. The docs resolver deploys from
// its own config, wrangler.docs-resolver.json.

console.error(`
[refuse-api-worker-deploy] Do not deploy apps/api as a Worker.

doxa-api-production is the thin edge Worker now, and the API runs on ECS.
This deploy would replace the edge with the old full API Worker.

  Deploy the API:            pnpm deploy:api   (the origin, then the edge)
  Deploy the docs resolver:  pnpm deploy:docs-resolver
  Roll back to the old full API Worker (an emergency only):
    pnpm --filter @doxahq/api-edge exec wrangler rollback <version-id> --env production

See docs/current/api-node-origin.md.
`);
process.exit(1);
