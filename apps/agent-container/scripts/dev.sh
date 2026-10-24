#!/usr/bin/env bash
# Starts the agent container for local development. The spec reader runs in
# a container of local Docker, as in production; without Docker it runs as a
# local child process. Set DOXA_UTILITY_MODE to choose the mode yourself.
set -euo pipefail

pnpm --filter @doxahq/agent build
pnpm --filter @doxahq/job-spec-reader bundle

if [[ -z "${DOXA_UTILITY_MODE:-}" ]]; then
  if docker info >/dev/null 2>&1 && pnpm --filter @doxahq/job-spec-reader image; then
    export DOXA_UTILITY_MODE=docker
  else
    echo "[agent] Docker is not available: the spec reader runs as a local child process." >&2
    export DOXA_UTILITY_MODE=local
  fi
fi

if [[ "$DOXA_UTILITY_MODE" == "docker" ]]; then
  # Containers and networks of runs that a stopped dev server left behind.
  stale_containers="$(docker ps -aq --filter label=doxa.utility.run)"
  if [[ -n "$stale_containers" ]]; then docker rm -f $stale_containers >/dev/null; fi
  stale_networks="$(docker network ls -q --filter label=doxa.utility.run)"
  if [[ -n "$stale_networks" ]]; then docker network rm $stale_networks >/dev/null; fi
fi

echo "[agent] Spec reader mode: $DOXA_UTILITY_MODE" >&2
exec tsx src/index.ts
