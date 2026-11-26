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
- `repository`: renames, transfers, deletes, and visibility changes keep the
  repository records true. A repository that becomes private pauses Doxabot.
  `created` adds the record of a new repository or fork of an installation on
  all repositories. GitHub sends no `installation_repositories` event for it.

GitHub always sends the app events `installation` (created, deleted,
suspended, unsuspended, permissions accepted) and `installation_repositories`
(repositories added or removed). They need no subscription. Doxa uses the
`sender` of `installation.created` to know who installed the app.

GitHub also sends `check_run` with the actions `rerequested` and
`requested_action` without a subscription, because the app has write access to
Checks. GitHub sends them only for check runs that the app created. See "The
preview check" below.

Doxabot works with public and private repositories. During the rollout, the
API flag `DOXABOT_PUBLIC_REPOSITORIES_ENABLED` is a kill switch for public
repositories. While it is not `"true"`, the API refuses Doxabot for a public
repository with the reason `public_repository_disabled`, and the dashboard
shows "Doxabot is not available for public repositories yet."

## Which pull requests Doxabot uses

- Doxabot ignores every pull request from a fork, whatever the author. It
  builds no preview and posts nothing on the pull request. Only a person with
  write access can push a branch to the repository, so a pull request from a
  branch in the repository is trusted.
- A fork is a separate repository with its own GitHub repository ID. To use
  Doxa on a fork, the owner of the fork installs the app on it and adds it as
  its own project. The pull requests inside that fork then get previews like
  in any other repository.
- To preview a pull request from a fork in the main repository, a maintainer
  pushes its branch to the main repository.
- A merged pull request from a fork still counts for merge runs: its code is
  now in the repository, and a maintainer accepted it. It never starts or
  updates a preview.
- Doxabot skips pull requests from bot accounts (GitHub user type `Bot`, for
  example Dependabot), unless the project owner allows that bot by name.
- The default merge trigger is `manual`, so nothing runs after a merge until
  the owner picks another trigger. See "Merge Triggers" in
  [`current/generation-reviews.md`](current/generation-reviews.md).
- Pull request previews are public pages on a random hostname. They are not
  indexed, and every page shows an "Unreviewed pull request preview" banner.
  Production sites never show it.

## The preview check

Each preview run reports on its pull request as one check run, "Doxa
documentation preview". Its external ID is the generation job ID.

| The run | The check |
| --- | --- |
| Queued, running | `queued`, then `in_progress`. |
| Succeeded | `success`, with a link to the preview. |
| Failed | `failure`, with the reason, a link to the run in the dashboard, and a "Retry preview" button. |
| Failed on a merge conflict | `action_required`, with a link to the run. It has no button: a retry cannot help. |
| Waited or ran too long | "Documentation preview timed out", with a link and a "Retry preview" button. A queued run is cancelled (`cancelled`), a running run fails (`failure`). |
| Cancelled, superseded, or stopped with its pull request | `cancelled`, with no button. |
| Stopped for AI credits | `neutral`, with a link to the billing page (billing spec 10.6). |

The API closes the check when the job ends: `markJobFailed`, `markJobTimedOut`,
`markJobCancelled` and `markJobStopped` on the internal API. The worker's
watchdog (5-minute cron) ends a run that waited 10 minutes or ran longer
than its time limit.

The API records when a check reached `completed`
(`generation_jobs.review_run_completed_at`, migration 0053). If GitHub refuses
a close, or a run ends without a close, the API cron closes the check from
the job's own end (`PreviewCheckSweeper`). The cron waits 2 minutes after the
end, and stops after 24 hours. GitHub marks a check `stale` only after 14
days, so the cron is the only timeout that a person sees.

### Running a preview again from GitHub

"Re-run" on the check and the "Retry preview" button start the same re-run
as the dashboard: a new run on the head of the pull request, with a new
check. Before the run starts, the API makes sure that:

- the check is the stored check of a preview job of the repository's project;
- the person who pressed the button can push to the repository
  (`GET /repos/{owner}/{repo}/collaborators/{login}/permission` is `admin` or
  `write`). A person who cannot push starts nothing, and an unanswered check
  also starts nothing.

The project owner pays for the run, as for a push. A run that worked runs
again too, because the person asked for it. The old run's log shows who asked,
and why nothing started if the API refused (`doxabot_retry_requested`,
`doxabot_retry_refused`). A pull request comment command (for example
`@doxabot preview`) is not supported yet.

## URLs in the app settings

| Setting | Value |
| --- | --- |
| Setup URL | `{API origin}/github/install/callback` |
| Callback URLs | `{API origin}/api/auth/callback/github` (sign-in) and `{API origin}/github/install/authorize` (install) |
| Request user authorization (OAuth) during installation | Off. When it is on, GitHub does not use the setup URL. |
| Redirect on update | Optional. When it is on, a change to the repository selection refreshes the repository list. |
| Expire user authorization tokens | Not recorded yet. |

The API origin is `BETTER_AUTH_URL`, for example `https://api.doxa.so`. Add
the callback URLs for every API origin that signs in with the app.

A GitHub App has only one webhook URL. Do not point the production app's
webhook at a development tunnel. Every production event then goes to the
development API, production gets none, and the development API writes checks
as the production app (found on 2026-11-25: it started on 2026-11-05). Use a
separate GitHub App for development, with its own ID, key and webhook secret in
`apps/api/.dev.vars`.

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
answers 409 and changes nothing.

## Who owns an installation

Every installation has one Doxa owner. The owner's projects use its
repositories. The route uses `GET /user` with the user access token to learn
which GitHub account the Doxa user controls now. A Doxa account does not need
a GitHub sign-in for this.

- **Organization.** Only the GitHub user who installed the app can claim it:
  the `sender` of the signed `installation.created` webhook. Doxa stores it in
  `github_installation_installers`. When another member of the organization
  tries, the route answers 403 and names the installer. When the webhook did
  not arrive yet, the route sends the person to
  `/dashboard?github=pending&installation_id=…`. The dashboard asks them to
  wait a few seconds and offers "Try again".
- **User account.** Only the GitHub user who owns the account can claim it.
- **Already recorded.** Only the current owner can connect it again.
- **Other members** of the organization get access through Doxa teams
  ([`current/teams.md`](current/teams.md)). The owner creates a team, adds
  the members, and creates the projects in the team. The installation stays
  with the owner.
- **Move the owner.** Account settings → GitHub installations. The owner moves
  an installation to a Doxa user who shares at least one Doxa team with them
  (`POST /github/installations/{id}/owner`). Projects keep their owners. The
  new owner then lists the repositories and creates new projects.

## Repository records

A GitHub repository has one Doxa record, which belongs to one installation.
When another installation lists the same repository, the record moves only
when one of these is true:

- both installations have the same Doxa owner;
- the old installation is not active (suspended or uninstalled);
- the app lost the repository on the old installation (the record is
  disconnected).

Otherwise the record stays, so the first owner's project keeps working.

Doxa adds records in three ways:

1. **Connect:** the install callback lists every repository that the user can
   access in the installation.
2. **Webhooks:** `repository.created` and `installation_repositories.added`
   add a record when Doxa knows the installation and has no record of the
   repository. An event never moves a record. `installation_repositories`
   gives no default branch, so Doxa reads it with a token limited to that
   repository and to metadata (two GitHub requests). If the read fails, the
   repository gets no record, and a refresh adds it.
3. **Refresh** (`POST /github/repos/refresh`, the Refresh button of the
   repository dialog): reads the list again with the user's GitHub sign-in
   token, which Better Auth renews when it expired. It spends only the user's
   own GitHub budget, and GitHub returns only the repositories that the user
   can access. The limits:
   - one refresh per installation each 60 seconds (`repositories_refreshed_at`,
     migration 0051); a click in that time gets 429 `refresh_cooldown` with
     `Retry-After`;
   - pages one after another, at most 50 pages of 100 repositories;
   - the refresh stops before the next page when fewer than 500 requests are
     left in the user's hourly GitHub budget, and reports a partial list.

   A refresh adds and updates records. It never removes one. A user without a
   GitHub sign-in, or with a token that GitHub refuses, gets 409
   `github_sign_in_unavailable` and uses "Manage GitHub access" instead. `local*` installation IDs work only when
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
