import assert from "node:assert/strict";
import test from "node:test";

import { listenArgs, readWebhookEvents, WEBHOOK_PATH } from "./dev-stripe-listen.mjs";

test("reads every webhook event of the billing package", () => {
  const events = readWebhookEvents();
  assert.equal(events.length, 15);
  assert.ok(events.includes("invoice.created"), "pay-as-you-go needs invoice.created");
  assert.ok(events.includes("checkout.session.completed"));
  assert.equal(new Set(events).size, events.length);
});

test("forwards to the billing webhook route of the API origin", () => {
  const args = listenArgs("http://localhost:8787/", ["--api-key", "sk_test_x"], ["invoice.paid", "invoice.created"]);
  assert.deepEqual(args, ["listen", "--events", "invoice.paid,invoice.created", "--forward-to", `http://localhost:8787${WEBHOOK_PATH}`, "--api-key", "sk_test_x"]);
});

test("refuses a URL with a path", () => {
  assert.throws(() => listenArgs("http://localhost:8787/billing", [], ["invoice.paid"]), /must be an origin/);
});

test("fails when the constant is missing", () => {
  assert.throws(() => readWebhookEvents("export const OTHER = [];"), /not found/);
});
