import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLIENT_ASSET_CACHE_CONTROL,
  CLIENT_ASSET_KEY_PREFIX,
  contentTypeForClientAsset,
  createClientAssetPutArgs,
  listClientAssetFiles,
  planClientAssetUploads,
  uploadClientAssets,
} from "../lib/client-assets-upload.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

async function createAssetsDirectory(files) {
  const directory = await mkdtemp(path.join(tmpdir(), "doxa-client-assets-"));
  for (const file of files) {
    const filePath = path.join(directory, ...file.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `/* ${file} */`);
  }
  return directory;
}

test("plans one upload for every file in the assets directory", async () => {
  const files = [
    "cytoscape.esm-D3_iZ_3b.js",
    "_-CirsNNBV.js",
    "styles-B1c2D3e4.css",
    "fonts/inter-Ab12Cd34.woff2",
  ];
  const directory = await createAssetsDirectory(files);

  const listed = await listClientAssetFiles(directory);
  const plan = planClientAssetUploads({ assetsDirectory: directory, files: listed });

  assert.deepEqual(listed, [...files].sort());
  assert.deepEqual(
    plan.map((upload) => upload.key),
    [...files].sort().map((file) => `${CLIENT_ASSET_KEY_PREFIX}${file}`),
  );
  assert.deepEqual(plan[0], {
    file: "_-CirsNNBV.js",
    filePath: path.join(directory, "_-CirsNNBV.js"),
    key: "client-assets/v1/assets/_-CirsNNBV.js",
    contentType: "text/javascript; charset=utf-8",
  });
  assert.deepEqual(
    await listClientAssetFiles(directory),
    listed,
    "planning does not change the directory",
  );
});

test("every key stays under the client-assets prefix", async () => {
  const directory = await createAssetsDirectory(["a-AAAAAAAA.js"]);
  const plan = planClientAssetUploads({
    assetsDirectory: directory,
    files: await listClientAssetFiles(directory),
  });

  for (const upload of plan) {
    assert.ok(upload.key.startsWith("client-assets/v1/assets/"));
    assert.ok(!upload.key.includes(".."));
  }
});

test("refuses an empty assets directory", () => {
  assert.throws(
    () => planClientAssetUploads({ assetsDirectory: "/empty", files: [] }),
    /No client assets found/,
  );
});

test("sets the content type from the extension", () => {
  assert.equal(contentTypeForClientAsset("a-AAAAAAAA.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForClientAsset("a-AAAAAAAA.CSS"), "text/css; charset=utf-8");
  assert.equal(contentTypeForClientAsset("font-AAAAAAAA.woff2"), "font/woff2");
  assert.equal(contentTypeForClientAsset("blob-AAAAAAAA.bin"), "application/octet-stream");
});

test("puts each file remotely with an immutable cache-control", () => {
  assert.equal(CLIENT_ASSET_CACHE_CONTROL, "public, max-age=31536000, immutable");
  assert.deepEqual(
    createClientAssetPutArgs("doxa-docs-renderer-code", {
      file: "a-AAAAAAAA.js",
      filePath: "/dist/client/assets/a-AAAAAAAA.js",
      key: "client-assets/v1/assets/a-AAAAAAAA.js",
      contentType: "text/javascript; charset=utf-8",
    }),
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      "doxa-docs-renderer-code/client-assets/v1/assets/a-AAAAAAAA.js",
      "--file",
      "/dist/client/assets/a-AAAAAAAA.js",
      "--content-type",
      "text/javascript; charset=utf-8",
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--remote",
      "--force",
    ],
  );
});

function createUploads(count) {
  return Array.from({ length: count }, (_, index) => ({
    file: `chunk${index}-AAAAAAAA.js`,
    filePath: `/assets/chunk${index}-AAAAAAAA.js`,
    key: `client-assets/v1/assets/chunk${index}-AAAAAAAA.js`,
    contentType: "text/javascript; charset=utf-8",
  }));
}

test("uploads every file, six at a time", async () => {
  let running = 0;
  let peak = 0;
  const started = [];
  const count = await uploadClientAssets({
    uploads: createUploads(20),
    bucket: "bucket",
    run: async (args, upload) => {
      started.push(upload.key);
      assert.equal(args[5], `bucket/${upload.key}`);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
    },
  });

  assert.equal(count, 20);
  assert.equal(peak, 6);
  assert.equal(new Set(started).size, 20);
});

test("starts no new upload after a failure", async () => {
  const started = [];
  await assert.rejects(
    uploadClientAssets({
      uploads: createUploads(20),
      bucket: "bucket",
      concurrency: 2,
      run: async (_args, upload) => {
        started.push(upload.key);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (started.length === 3) throw new Error("put failed");
      },
    }),
    /put failed/,
  );
  assert.ok(started.length < 20);
});

test("deploy-renderer uploads client assets only after the dry-run exit", async () => {
  const source = await readFile(
    path.join(workspaceRoot, "apps/docs-template/scripts/deploy-renderer.mjs"),
    "utf8",
  );
  const dryRunExit = source.indexOf("if (options.dryRun)");
  const upload = source.indexOf("await uploadBuildClientAssets(");
  const sharedDeploy = source.indexOf(
    'run("pnpm", ["exec", "wrangler", "deploy", "-c", sharedGeneratedConfigPath]',
  );
  assert.ok(dryRunExit > 0 && upload > dryRunExit, "upload runs after the dry-run exit");
  assert.ok(sharedDeploy > upload, "upload runs before the shared renderer deploy");
});
