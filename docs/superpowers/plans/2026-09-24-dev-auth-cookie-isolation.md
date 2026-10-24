# Development authentication cookie isolation

## Change

`AUTH_COOKIE_PREFIX` optionally sets Better Auth's cookie prefix. An absent or blank value preserves the existing production names.
Local `apps/api/.dev.vars` now sets `AUTH_COOKIE_PREFIX=doxa-dev` and retains `AUTH_COOKIE_DOMAIN=dev.doxa.so`.
The example environment file documents the same separation. Production config and session lifetimes remain unchanged.

Development must not consume production cookies that the browser sends from the parent `.doxa.so` domain.
The prefix covers session tokens, cached session data, and OAuth state through Better Auth's cookie factory.
Old cookies are ignored, not deleted. No production cookie cleanup is required.

## Verification strategy

```yaml
test_strategy:
  artifact: "development auth cookie isolation"
  rationale: "Same-name production cookies can cause local authentication failures."
  criticality: "HIGH"
  selected_types:
    - rationale: "Environment defaults must preserve production behavior."
      type: "unit"
      size: "small"
      framework: "vitest"
      dependencies: ["real createAuth configuration"]
      gate: "Gate 1"
    - rationale: "Cookie parsing and cache expiry must work with both environments present."
      type: "integration"
      size: "small"
      framework: "vitest"
      dependencies: ["real Better Auth handlers and cryptography", "token-specific database adapter fake", "controlled clock"]
      gate: "Gate 2"
  rejected_types:
    - reason: "No UI components change."
      type: "component"
    - reason: "The deterministic integration tests cover both cookie orders and expiry without a live GitHub login."
      type: "e2e"
    - reason: "No production deployment is authorized."
      type: "smoke"
    - reason: "No external API contract changes."
      type: "contract"
    - reason: "The relevant states are a small explicit matrix, not a new parsing algorithm."
      type: "property-based"
  deliberately_skipped:
    - why: "The active local Worker still has the old environment. Its restart remains under user control."
      what: "Real browser OAuth and six-minute interactive session verification"
```

## Cases covered

- [integration] Given production and development cookies in either order, each auth instance returns only its own user.
- [integration] Given fresh, expired, or removed development cache cookies, a valid stored session remains authenticated.
- [integration] Given only production cookies, development returns no session.
- [integration] Given a development sign-out, response cookies expire only within the development namespace and domain.
- [unit] Given no prefix, production cookie names, scope, security attributes, and lifetimes remain unchanged.
- [unit] Given a development prefix, session and OAuth state cookies use it.
- [unit] Given a prefix without a domain or execution context, host-only cookies still use the prefix.
- [unit] Given a blank prefix, the existing default remains in effect.

## Manual verification

1. Stop the existing `pnpm dev` process with Ctrl-C.
2. Start `pnpm dev` again to load the environment change.
3. Log in at `https://dev.doxa.so` once.
4. Keep the production login open in the same browser profile.
5. After six minutes, use the development dashboard again.

The new development session must remain valid. The production login must remain unchanged.
Do not clear cookies for the whole `doxa.so` domain.
