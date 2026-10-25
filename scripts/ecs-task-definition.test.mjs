import assert from "node:assert/strict";
import test from "node:test";
import {
  REGISTERABLE_FIELDS,
  assertPinnedImage,
  carriedDeployVariables,
  nextRevisionWithImage,
  parseEnvironmentAssignments,
} from "./lib/ecs-task-definition.mjs";

const OLD_IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:aaaaaaa";
const NEW_IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:bbbbbbb";

/** A task definition as `aws ecs describe-task-definition` returns it. */
function describedTaskDefinition() {
  return {
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/doxa-api-production:7",
    family: "doxa-api-production",
    revision: 7,
    status: "ACTIVE",
    taskRoleArn: "arn:aws:iam::123456789012:role/doxa-api-production-task",
    executionRoleArn: "arn:aws:iam::123456789012:role/doxa-api-production-execution",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    compatibilities: ["EC2", "FARGATE"],
    requiresAttributes: [{ name: "com.amazonaws.ecs.capability.logging-driver.awslogs" }],
    cpu: "2048",
    memory: "4096",
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    volumes: [],
    placementConstraints: [],
    registeredAt: "2026-10-24T10:00:00.000Z",
    registeredBy: "arn:aws:iam::123456789012:user/terraform",
    containerDefinitions: [
      { name: "api", image: OLD_IMAGE, essential: true, environment: [{ name: "PORT", value: "8786" }] },
      { name: "cloudflared", image: "cloudflare/cloudflared:2026.10.3", essential: true },
    ],
  };
}

test("replaces the image of the named container only", () => {
  const revision = nextRevisionWithImage(describedTaskDefinition(), { containerName: "api", image: NEW_IMAGE });

  assert.equal(revision.containerDefinitions[0].image, NEW_IMAGE);
  assert.deepEqual(revision.containerDefinitions[0].environment, [{ name: "PORT", value: "8786" }]);
  assert.equal(revision.containerDefinitions[1].image, "cloudflare/cloudflared:2026.10.3");
});

test("keeps only the fields that registration accepts", () => {
  const revision = nextRevisionWithImage(describedTaskDefinition(), { containerName: "api", image: NEW_IMAGE });

  for (const field of Object.keys(revision)) assert.ok(REGISTERABLE_FIELDS.includes(field), field);
  for (const readOnly of ["taskDefinitionArn", "revision", "status", "compatibilities", "requiresAttributes", "registeredAt", "registeredBy"]) {
    assert.equal(revision[readOnly], undefined, readOnly);
  }
  assert.equal(revision.cpu, "2048");
  assert.deepEqual(revision.runtimePlatform, { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" });
});

test("does not change the described task definition", () => {
  const described = describedTaskDefinition();
  nextRevisionWithImage(described, { containerName: "api", image: NEW_IMAGE });

  assert.equal(described.containerDefinitions[0].image, OLD_IMAGE);
});

test("carries the tags of the current revision", () => {
  const tags = [{ key: "Service", value: "api" }];
  const revision = nextRevisionWithImage(describedTaskDefinition(), { containerName: "api", image: NEW_IMAGE, tags });

  assert.deepEqual(revision.tags, tags);
  assert.equal("tags" in nextRevisionWithImage(describedTaskDefinition(), { containerName: "api", image: NEW_IMAGE }), false);
});

test("rejects a container that the task definition does not have", () => {
  assert.throws(
    () => nextRevisionWithImage(describedTaskDefinition(), { containerName: "web", image: NEW_IMAGE }),
    /no container "web" \(containers: api, cloudflared\)/,
  );
});

test("accepts commit tags and digests", () => {
  assertPinnedImage(NEW_IMAGE);
  assertPinnedImage(`123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api@sha256:${"a".repeat(64)}`);
  assertPinnedImage("localhost:5000/doxa-api:06e82a5");
});

test("rejects images without an exact tag", () => {
  assert.throws(() => assertPinnedImage("123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api"), /must be/);
  assert.throws(() => assertPinnedImage("123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:latest"), /latest tag/);
  assert.throws(() => assertPinnedImage("doxa-api:abc"), /must be/);
});

test("sets environment variables of the named container, sorted by name", () => {
  const revision = nextRevisionWithImage(describedTaskDefinition(), {
    containerName: "api",
    image: NEW_IMAGE,
    environment: { PORT: "9000", DOXA_RENDERER_RELEASE_ID: "release-42" },
  });

  assert.deepEqual(revision.containerDefinitions[0].environment, [
    { name: "DOXA_RENDERER_RELEASE_ID", value: "release-42" },
    { name: "PORT", value: "9000" },
  ]);
  assert.equal(revision.containerDefinitions[1].environment, undefined);
});

test("parses NAME=VALUE assignments and refuses anything else", () => {
  assert.deepEqual(parseEnvironmentAssignments(["DOXA_RENDERER_RELEASE_ID=a=b", "EMPTY="]), {
    DOXA_RENDERER_RELEASE_ID: "a=b",
    EMPTY: "",
  });
  assert.throws(() => parseEnvironmentAssignments(["lower=x"]), /UPPER_SNAKE_CASE/);
  assert.throws(() => parseEnvironmentAssignments(["NO_VALUE"]), /NAME=VALUE/);
});

/** A described revision whose api container has these variables. */
function revisionWith(variables) {
  const described = describedTaskDefinition();
  described.containerDefinitions[0].environment = Object.entries(variables).map(([name, value]) => ({ name, value }));
  return described;
}

test("carries the renderer release from the running revision when a Terraform revision lacks it", () => {
  const terraformRevision = revisionWith({ PORT: "8786" });
  const running = revisionWith({ PORT: "8786", DOXA_RENDERER_RELEASE_ID: "release-1" });

  assert.deepEqual(carriedDeployVariables(terraformRevision, running, "api", {}), { DOXA_RENDERER_RELEASE_ID: "release-1" });
});

test("does not carry a deploy variable that the deploy sets or the base already has", () => {
  const running = revisionWith({ DOXA_RENDERER_RELEASE_ID: "release-1" });

  assert.deepEqual(carriedDeployVariables(revisionWith({}), running, "api", { DOXA_RENDERER_RELEASE_ID: "release-2" }), {});
  assert.deepEqual(carriedDeployVariables(revisionWith({ DOXA_RENDERER_RELEASE_ID: "release-0" }), running, "api", {}), {});
  assert.deepEqual(carriedDeployVariables(revisionWith({}), null, "api", {}), {});
});

test("carries only deploy variables, never Terraform settings", () => {
  const running = revisionWith({ DOXA_RENDERER_RELEASE_ID: "release-1", BETTER_AUTH_URL: "https://old.example" });

  assert.deepEqual(carriedDeployVariables(revisionWith({}), running, "api", {}), { DOXA_RENDERER_RELEASE_ID: "release-1" });
});
