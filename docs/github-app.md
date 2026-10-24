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
