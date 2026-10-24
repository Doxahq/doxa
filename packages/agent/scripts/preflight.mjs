import {
  assertMdxValidatorReady,
  disposeMdxValidatorPool,
} from "../dist/index.js";

try {
  await assertMdxValidatorReady();
  process.stdout.write(`${JSON.stringify({
    service: "doxa-agent-runtime",
    eventType: "runtime_preflight_complete",
  })}\n`);
} finally {
  await disposeMdxValidatorPool();
}
