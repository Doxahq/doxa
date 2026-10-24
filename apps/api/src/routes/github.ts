import { createApiRouter } from "../http/app";
import type { ApiApp } from "../http/app";
import { getWebOrigin } from "../http/access";
import { withUser } from "../http/auth";
import { error, json } from "../http/response";
import { GitHubRepository } from "../repositories/github";
import { createInstallationAccessToken, listInstallationRepositories } from "../services/github-app";
import { verifyGitHubWebhook } from "../services/github-webhook";
import { DoxabotWebhookOrchestrator } from "../services/doxabot/webhook-orchestrator";
import { MergeGenerationScheduler } from "../services/doxabot/merge-generations";

export function createGitHubRoutes(): ApiApp {
  const app = createApiRouter();

  app.post("/webhook", async (context) => {
    const deliveryId = context.req.header("x-github-delivery");
    const eventName = context.req.header("x-github-event");
    if (!deliveryId || !eventName) {
      return error("Missing required GitHub webhook headers.", 400);
    }

    const body = await context.req.raw.text();
    const valid = await verifyGitHubWebhook(context.req.raw, context.env, body);
    if (!valid) return error("Invalid GitHub webhook signature.", 401);

    // Built on the first merge only: most deliveries record no merge.
    const orchestrator = DoxabotWebhookOrchestrator.fromEnv(context.env, {
      mergeTriggers: {
        recordMerge: (merge) =>
          MergeGenerationScheduler.fromEnv(context.env, (promise) =>
            context.executionCtx.waitUntil(promise),
          ).recordMerge(merge),
      },
    });
    const ingress = await orchestrator.ingest({
      deliveryId,
      eventName,
      rawBody: body,
    });
    if (ingress.outcome === "duplicate") {
      return json({ ok: true, outcome: "duplicate" });
    }

    const processing = orchestrator.processDelivery({
      provider: "github",
      deliveryId,
    });
    context.executionCtx.waitUntil(processing.catch((caught) => {
      console.error("Doxabot webhook processing failed.", caught);
    }));

    return json(
      { ok: true, outcome: "accepted" },
      { status: 202 },
    );
  });

  app.get("/install", (context) => {
    if (!context.env.GITHUB_APP_SLUG) {
      return error("GITHUB_APP_SLUG is required to start GitHub App installation.", 500);
    }

    return Response.redirect(`https://github.com/apps/${context.env.GITHUB_APP_SLUG}/installations/new`, 302);
  });

  app.get("/install/callback", (context) =>
    withUser(context, async (userId) => {
      const installationId = context.req.query("installation_id");
      if (!installationId) return error("Missing installation_id.", 400);

      const repo = new GitHubRepository(context.env);
      const installation = await repo.recordInstallation({
        userId,
        installationId,
        accountLogin: context.req.query("account") ?? "unknown",
        accountType: "User",
      });

      if (installationId.startsWith("local")) {
        await repo.recordRepository({
          installationId: installation.id,
          githubRepoId: "local-doxa-demo",
          fullName: "local/doxa-demo",
          owner: "local",
          name: "doxa-demo",
        });
      } else {
        const token = await createInstallationAccessToken(context.env, installationId);
        const repositories = await listInstallationRepositories(token.token);
        await Promise.all(
          repositories.map((repository) =>
            repo.recordRepository({
              installationId: installation.id,
              ...repository,
            }),
          ),
        );
      }

      return Response.redirect(`${getWebOrigin(context.req.raw, context.env)}/dashboard?github=connected`, 302);
    }),
  );

  app.get("/repos", (context) =>
    withUser(context, async (userId) => {
      const repos = await new GitHubRepository(context.env).listReposForUser(userId);
      return json({ repositories: repos });
    }),
  );

  return app;
}
