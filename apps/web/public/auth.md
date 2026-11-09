# Doxa agent setup

You are an agent. Follow these steps to connect a user to Doxa. Doxa writes and hosts documentation from a code repository, and has an MCP server for agents.

The flow: start a claim, give the link and the code to the user, wait for approval, connect to MCP, and test the connection.

## Rules

- Do not show `claim_token` or `access_token` in the chat, in logs, or in a tracked file.
- Treat the link and the 6-digit code as the only values that the user sees.
- Do not ask the user for a password or for a token.
- If a request returns `429`, stop and tell the user. Do not retry in a loop.

## Service

- API: `https://api.doxa.so`
- MCP server: `https://mcp.doxa.so/mcp` (Streamable HTTP)
- Metadata: `https://api.doxa.so/.well-known/oauth-authorization-server`, in the `agent_auth` block.

## Step 1: Start a claim

```http
POST https://api.doxa.so/agent/identity
Content-Type: application/json

{
  "type": "service_auth",
  "client_name": "Claude Code",
  "token_name": "Acme docs (local)",
  "scope": "projects:read projects:write docs:read docs:write generation:run"
}
```

- `client_name` is the name of your client. It has a maximum of 60 characters.
- `token_name` is a label for this project. The user sees it in Settings. It has a maximum of 60 characters.
- `login_hint` is optional. Send it only if the user gave you an email. Doxa then accepts only the account with that email.
- `scope` lists the access that you request. The user approves each permission.

The response has `claim_token`, `claim.verification_uri`, `claim.user_code`, `claim.expires_in`, and `claim.interval`. Keep `claim_token` in memory only.

## Step 2: Give the link and the code to the user

If you run on the computer of the user, open the link with `open` (macOS) or `xdg-open` (Linux). Always send this message too, with the real values:

---

**Connect your Doxa account**

1. Open this link:

```
{claim.verification_uri}
```

2. Sign in or sign up.

3. Enter this setup code within 5 minutes. It is only in this chat. Doxa does not send it by email:

```
{claim.user_code}
```

4. Check the permissions and the projects, then select Allow. All of them start selected. Clear any that you do not want to give me.

---

## Step 3: Wait for approval

Send this request every `claim.interval` seconds, after you send the message in Step 2:

```http
POST https://api.doxa.so/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=<claim_token>
```

| `error` | Meaning | Action |
| --- | --- | --- |
| `authorization_pending` with `link_not_opened` | The user did not open the link. | Keep polling. |
| `authorization_pending` with `user_action_required` | The user must sign in, verify the email, enter the code, and approve. | Keep polling. |
| `slow_down` | You polled too fast. | Add 5 seconds to the interval. |
| `expired_token` | The claim ended. | Tell the user. Start again only if the user agrees. |
| `access_denied` | The user denied the claim, or the code failed 5 times. | Tell the user. Start again only if the user agrees. |
| `invalid_grant` | The claim token is not valid. | Stop and tell the user. |

On success, the response has `access_token` (`doxa_at_...`), `expires_in` (90 days in seconds), `scope`, and `mcp_url`. The token also stops working after 30 days without use. This response comes one time only, so do not print it. Doxa then sends the user an email about the new agent.

## Step 4: Connect to MCP

Keep the token out of the chat, your tool calls, and shell history. Have the script that polls in Step 3 write `access_token` straight to a private file, for example with mode 600 in a temporary folder. Then read it from that file, and delete the file after this step.

Put the token only in a local MCP config that git does not track. Do not use a `${VAR}` value from an ignored file, because the client reads variables only from its own environment.

Claude Code (`--scope local` is not tracked by git):

```bash
claude mcp add --transport http --scope local doxa https://mcp.doxa.so/mcp --header "Authorization: Bearer $(cat "$TOKEN_FILE")"
```

Cursor: have a script add this entry to `~/.cursor/mcp.json`, with the token read from the file. Keep the other servers in the file:

```json
{ "mcpServers": { "doxa": { "url": "https://mcp.doxa.so/mcp", "headers": { "Authorization": "Bearer <access_token>" } } } }
```

Other clients: add a remote Streamable HTTP server with the same URL and header, in a config outside the repository.

If the tools do not appear in this session, tell the user to restart the client.

## Step 5: Test the connection

Call the `get_account` tool once. Tell the user which account and permissions it returned.

## Step 6: Create the docs

1. Call `list_github_repositories`.
2. If the list has the repository, call `create_project` with `source: "repository"`. Then call `start_generation`.
3. If the list is empty, tell the user to install the GitHub App at `https://doxa.so/dashboard/projects/new`. To start without a repository, call `create_project` with `source: "example"`.

Some actions need approval from a person: publish, restore, generation, custom domains, and project delete. These tools return an approval link. Give the link to the user.

## Revoke the token

The user can revoke the token in Settings, under Connected agents. To revoke it from the agent:

```http
POST https://api.doxa.so/oauth/token
Content-Type: application/x-www-form-urlencoded

token=<access_token>
```
