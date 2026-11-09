# Agent signup

## Purpose

A user pastes one line into an agent. The agent reads `https://doxa.so/auth.md`, starts a claim, and shows a link and a 6-digit code. The user approves in a browser. The agent gets a token and connects to the MCP server. MCP OAuth stays available for clients that support it.

The flow follows the [auth.md protocol](https://github.com/workos/auth.md) (`service_auth` only).

## Switch

`AGENT_SIGNUP_ENABLED` opens the flow. Only the exact value `true` opens it. When it is off, `POST /agent/identity`, the claim grant, and the claim routes answer `503`, and the metadata has no `agent_auth` block. Existing agent tokens keep working. Revoke them to end access.

## Flow

1. `POST /agent/identity` creates a row in `agent_claims` and returns the claim token, the link, and the code.
2. The link opens `/oauth/claim?attempt=...` in `apps/web`. The page calls `POST /agent-access/claims/open`. The claim ends 5 minutes after it started, and opening the link does not extend it. Sign-up and email verification must fit in these 5 minutes. After that, the person asks the agent for a new code.
3. A signed-out person goes to `/login`, and returns through the `redirect` value.
4. The person enters the code, picks permissions and projects, and selects Allow (`POST /agent-access/claims/approve`).
5. The agent polls `POST /oauth/token` with the claim grant. After approval, the poll creates the token, one time. The agent has 5 minutes to collect it.

## Token

An agent token has the format `doxa_at_...`, ends 90 days after it is issued or after 30 days without use, and is stored in `agent_tokens` as a SHA-256 hash. `OAuthTokenValidator` checks the token format and sends an agent token to `AgentTokenAuthenticator`, which returns the same shape as an OAuth access token. The MCP server, the tool scopes, the project scope, and the approval rules are therefore the same for both kinds of credential.

A static MCP header cannot refresh a token, so the 1-hour OAuth access token does not fit this flow.

## Security rules

- Doxa never sends the code by email. The agent request cannot send mail to an address.
- The database has only hashes of the claim token, the link token, the code, and the agent token. The code hash includes the link token, because a hash of 6 digits alone is easy to reverse.
- A code attempt is spent before the comparison, so parallel guesses cannot pass the limit of 5. The fifth wrong code locks the claim.
- Each state change is one conditional SQL statement. A claim can be approved once and redeemed once.
- If the agent sends `login_hint`, only the account with that email can approve. Nothing tells the agent if an account exists.
- The page shows the agent name as unverified, and starts with every requested permission and all projects selected. The OAuth consent page keeps the SEC-013 defaults: read permissions only and selected projects.
- Limits: 10 registrations per minute per IP at the edge (`API_AGENT_IDENTITY_LIMITER`), 20 per hour per IP, 5 per hour per email and IP, 20 per hour per email, and 25 active tokens per user. The counts and the insert are one transaction under advisory locks.
- Each agent token has its own client ID, so that branch and upload ownership separate two agents of one user. The tokens of one user still share one MCP rate limit.
- After a token is issued, the `agent-connected` email tells the person which agent got access, with a link to revoke it. A person who was tricked into an approval can then act. A failed email does not take the token from the agent.
- Claim secrets travel in the request body, so they stay out of the access logs of the API. The link token is in the page URL, and is useless without the code.

## Deploy order

1. Run migration `0044_agent_signup`. The Connected agents list reads `agent_tokens`.
2. Deploy `doxa-api` and the `doxa-web` Worker.
3. Set `AGENT_SIGNUP_ENABLED=true`.

New signups also need `AUTH_SIGNUPS_ENABLED=true`. Other accounts can connect a repository only when the `doxabot` GitHub App is public.

## Related files

- `apps/api/src/services/agent-signup/`
- `apps/api/src/repositories/agent-claims.ts`, `agent-tokens.ts`
- `apps/web/src/components/oauth/claim-page.tsx`
- `apps/web/public/auth.md`
