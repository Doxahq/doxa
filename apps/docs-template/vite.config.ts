import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

import {
  getDeploymentTarget,
  getDevAllowedHosts,
  getHostingPlugins,
} from "./src/config/vite/deployment";
import { eagerServerChunksPlugin } from "./src/config/vite/eager-server-chunks";
import { createMdxPlugin } from "./src/config/vite/mdx";
import { mdxSourceCapturePlugin } from "./src/config/vite/mdx-source-capture";
import { searchDataPlugin } from "./src/config/vite/search-data";
import { createStartConfig } from "./src/config/vite/start";
import { workspaceSourceAliases } from "./src/config/vite/workspace-aliases";
import { resolveSiteUrl } from "./src/lib/site-url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const deploymentTarget = getDeploymentTarget();
  const sitemapHost = resolveSiteUrl({
    ...process.env,
    ...env,
  });
  // `scripts/deploy-renderer.mjs` builds the platform renderer. It reads every
  // page through the dispatcher binding, and the Dynamic Worker compiles every
  // server module on each cold start. So that build leaves out the local
  // content source, minifies the server code, and imports the chunks of
  // every page render at startup (see `eagerServerChunksPlugin`).
  const isPlatformRendererBuild = process.env.DOXA_RENDERER_BUILD === "platform";
  const buildConfig =
    deploymentTarget === "cloudflare"
      ? {
          ...(isPlatformRendererBuild ? { minify: "esbuild" as const } : {}),
          rollupOptions: {
            output: {
              manualChunks: {
                react: ["react", "react-dom"],
              },
            },
          },
        }
      : undefined;

  const startConfig = createStartConfig(deploymentTarget, sitemapHost);

  return {
    base: "/",
    resolve: {
      alias: workspaceSourceAliases,
    },
    server: {
      port: 3000,
      allowedHosts: getDevAllowedHosts(),
    },
    build: buildConfig,
    define: isPlatformRendererBuild
      ? { "import.meta.env.DOXA_OMIT_LOCAL_CONTENT_SOURCE": "true" }
      : {},
    plugins: [
      tsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      createMdxPlugin(),
      mdxSourceCapturePlugin(),
      searchDataPlugin(),
      tailwindcss(),
      tanstackStart(startConfig),
      viteReact(),
      ...getHostingPlugins(deploymentTarget),
      ...(isPlatformRendererBuild ? [eagerServerChunksPlugin()] : []),
    ],
  };
});
