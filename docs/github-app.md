# Doxa GitHub App

The Doxa GitHub App supplies repository access, Doxabot webhook events, and
documentation-preview Check Runs. Doxa requests only the repository permissions
needed for those operations.

## Required repository permissions

| Permission | Access | Purpose |
| --- | --- | --- |
| Metadata | Read | Identify the selected repository. |
| Contents | Read | Read the source revision used to generate documentation. |
| Pull requests | Read | Receive and interpret pull-request changes. |
| Checks | Write | Create and update the Doxa documentation preview Check Run. |

The app subscribes only to these repository events:

- `pull_request`
- `push`

Doxabot currently rejects public repositories in platform policy even if the
GitHub App can observe them.

## URLs in the app settings

| Setting | Value |
| --- | --- |
| Setup URL | `{API origin}/github/install/callback` |
| Callback URLs | `{API origin}/api/auth/callback/github` (sign-in) and `{API origin}/github/install/authorize` (install) |
| Request user authorization (OAuth) during installation | Off. When it is on, GitHub does not use the setup URL. |
| Redirect on update | Optional. When it is on, a change to the repository selection refreshes the repository list. |

The API origin is `BETTER_AUTH_URL`, for example `https://api.doxa.so`. Add
the URLs for every API origin that uses the app, such as a development tunnel.

## Connecting an installation

GitHub sends the person to the setup URL with an `installation_id`. Anyone can
type that ID, so the setup URL does not record it. The flow is:

1. `/github/install/callback` accepts only a numeric `installation_id`. It
   signs an OAuth `state` that holds the Doxa user ID, the installation ID, an
   expiry of 10 minutes, and a nonce. The nonce also goes in a host-only
   `doxa_github_install` cookie.
2. The route sends the person to the GitHub authorization page of the app.
   A person who signed in with GitHub already authorized the app, so GitHub
   sends them back at once.
3. `/github/install/authorize` checks the state signature, the user, the
   expiry, and the cookie nonce. Then it clears the cookie.
4. The route exchanges the `code` for a user access token. It records the
   installation only if `GET /user/installations` returns it for that token.
   The account login and type come from GitHub, not from the query string.
5. The route records only the repositories that
   `GET /user/installations/{id}/repositories` returns for that token.

An installation that another Doxa user already owns keeps its owner. The route
answers 409 and changes nothing. `local*` installation IDs work only when
`LOCAL_GITHUB_TOKEN` is set, which production does not do.

## Installation-token scope

The Checks adapter requests an installation token for the single stored GitHub
repository ID involved in the generation job. It also reduces that token to the
permissions listed above. It does not mint an installation-wide token for Check
Run operations.

## Permission-change checkpoint

Changing the registered GitHub App permissions prompts existing installation
owners to approve the new access. Updating the live app registration is an
external operation and must be explicitly approved before it is performed.

For this implementation phase:

- the required manifest values and runtime behavior are documented;
- no live GitHub App registration or installed permission was changed;
- after approval, update the app registration to the permission and event list
  above, then have installation owners accept the requested permission change.
