#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/doxa-dev-env.XXXXXX")"

WITH_DB=1
WITH_TUNNEL=1
WITH_DOCS=1
WITH_RENDERER=1
WITH_AGENT=1
WITH_MCP=1
API_RUNTIME="worker"
USE_DEV_USER=0
RUN_MIGRATIONS=0
STOP_DB_ON_EXIT=0
DB_STARTED=0
SERVICE_COUNT=0
DOCS_RENDERER_DIR="${DOXA_DOCS_RENDERER_DIR:-${ROOT_DIR}/apps/docs-template}"
DOCS_RUNTIME_ENV_FILE=""
DOCS_CONTENT_TOKEN=""
AGENT_WORKER_CONFIG_FILE=""
EMAIL_WORKER_CONFIG_FILE=""
LOCAL_OPENROUTER_API_KEY=""
LOCAL_ANTHROPIC_API_KEY=""

PIDS=()
NAMES=()
CLEANED_UP=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RESET="$(printf '\033[0m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  BLUE="$(printf '\033[34m')"
  MAGENTA="$(printf '\033[35m')"
  CYAN="$(printf '\033[36m')"
  WHITE="$(printf '\033[37m')"
else
  RESET=""
  DIM=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  MAGENTA=""
  CYAN=""
  WHITE=""
fi

usage() {
  cat <<'USAGE'
Usage: pnpm dev [options]

Starts the Doxa local development stack with prefixed logs:
  - Docker Postgres
  - API Worker on http://localhost:8787
  - generation queue consumer with a local Cloudflare Workflow
  - docs runtime Worker on http://localhost:8788
  - shared docs renderer on http://<project>.localhost:3002
  - API playground gateway on http://127.0.0.1:8792, for "Try it" on the renderer
  - agent container on http://localhost:8789
  - MCP server Worker on http://localhost:8791/mcp
  - web app on http://localhost:3001
  - existing Cloudflare Tunnel, usually https://dev.doxa.so

Options:
  --with-agent         Start the local generation worker and agent container (the default).
  --no-agent           Do not start the local generation worker or agent container.
  --no-db             Do not start Docker Postgres or tail its logs.
  --no-docs           Do not start the docs runtime Worker.
  --with-renderer     Start the shared docs renderer and content runtime (the default).
  --no-renderer       Keep the legacy runtime preview without starting the shared renderer.
  --no-tunnel         Do not start the Cloudflare Tunnel.
  --no-mcp            Do not start the MCP server Worker.
  --api-node          Run the API as the Node origin on :8786 behind the thin
                      doxa-api Worker on :8787, with Valkey from Docker Compose.
  --dev-user          Use a synthetic local-dev-user instead of real auth.
  --real-auth         Use real Better Auth sessions (the default).
  --migrate           Run local database migrations after Postgres is healthy.
  --stop-db-on-exit   Stop Docker Compose services when this script exits.
  -h, --help          Show this help.

Environment:
  DOXA_DEV_WITH_AGENT=1       Same as --with-agent.
  DOXA_DEV_NO_AGENT=1         Same as --no-agent.
  DOXA_DEV_NO_TUNNEL=1        Same as --no-tunnel.
  DOXA_DEV_TUNNEL_ENV_FILE=... Override the local tunnel environment file.
  DOXA_DEV_TUNNEL_WAIT_SECONDS=... Tunnel readiness window (default: 60).
  DOXA_DEV_NO_RENDERER=1      Same as --no-renderer.
  DOXA_DEV_NO_MCP=1           Same as --no-mcp.
  DOXA_DEV_API_NODE=1         Same as --api-node.
  DOXA_DOCS_RENDERER_DIR=...  Override the apps/docs-template path.
  CLOUDFLARED_PROTOCOL=...    Tunnel transport: http2 (default), quic, or auto.
  DOXA_DEV_USER=1             Same as --dev-user.
  DOXA_DEV_REAL_AUTH=1        Same as --real-auth.
  DOXA_DEV_RUN_MIGRATIONS=1   Same as --migrate.
USAGE
}

log() {
  printf '%s[dev-env]%s %s\n' "${WHITE}" "${RESET}" "$*"
}

warn() {
  printf '%s[dev-env]%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2
}

fail() {
  printf '%s[dev-env]%s %s\n' "${RED}" "${RESET}" "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_port_available() {
  local name="$1"
  local port="$2"
  local listener
  local owner
  local pid

  listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 "|" $2 }' || true)"
  [ -z "$listener" ] && return

  IFS='|' read -r owner pid <<< "$listener"
  fail "${name} port ${port} is already in use by ${owner} (PID ${pid}). Stop the existing pnpm dev process before starting another stack."
}

check_dev_ports() {
  require_port_available "web" 3001
  require_port_available "API" 8787
  require_port_available "API inspector" 9230

  if [ "$API_RUNTIME" = "node" ]; then
    require_port_available "API origin" 8786
  fi

  if [ "$WITH_AGENT" -eq 1 ]; then
    require_port_available "agent container" 8789
  fi

  if [ "$WITH_DOCS" -eq 1 ]; then
    require_port_available "docs content runtime" 8788
    require_port_available "docs inspector" 9231
  fi

  if [ "$WITH_RENDERER" -eq 1 ]; then
    require_port_available "docs renderer" 3002
    require_port_available "API playground gateway" 8792
    require_port_available "API playground gateway inspector" 9235
  fi

  if [ "$WITH_MCP" -eq 1 ]; then
    require_port_available "MCP server" 8791
    require_port_available "MCP inspector" 9233
  fi
}

terminate_process_tree() {
  local target_pid="$1"
  local child_pid

  while IFS= read -r child_pid; do
    [ -n "$child_pid" ] && terminate_process_tree "$child_pid"
  done < <(pgrep -P "$target_pid" 2>/dev/null || true)

  kill -TERM "$target_pid" >/dev/null 2>&1 || true
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      ;;
    --with-agent)
      WITH_AGENT=1
      ;;
    --no-agent)
      WITH_AGENT=0
      ;;
    --no-db)
      WITH_DB=0
      ;;
    --no-docs)
      WITH_DOCS=0
      WITH_RENDERER=0
      ;;
    --no-mcp)
      WITH_MCP=0
      ;;
    --api-node)
      API_RUNTIME="node"
      ;;
    --with-renderer)
      WITH_DOCS=1
      WITH_RENDERER=1
      ;;
    --no-renderer)
      WITH_RENDERER=0
      ;;
    --no-tunnel)
      WITH_TUNNEL=0
      ;;
    --dev-user)
      USE_DEV_USER=1
      ;;
    --real-auth)
      USE_DEV_USER=0
      ;;
    --migrate)
      RUN_MIGRATIONS=1
      ;;
    --stop-db-on-exit)
      STOP_DB_ON_EXIT=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

[ "${DOXA_DEV_WITH_AGENT:-}" = "1" ] && WITH_AGENT=1
[ "${DOXA_DEV_NO_AGENT:-}" = "1" ] && WITH_AGENT=0
[ "${DOXA_DEV_NO_TUNNEL:-}" = "1" ] && WITH_TUNNEL=0
[ "${DOXA_DEV_NO_RENDERER:-}" = "1" ] && WITH_RENDERER=0
[ "${DOXA_DEV_NO_MCP:-}" = "1" ] && WITH_MCP=0
[ "${DOXA_DEV_API_NODE:-}" = "1" ] && API_RUNTIME="node"
[ "${DOXA_DEV_USER:-}" = "1" ] && USE_DEV_USER=1
[ "${DOXA_DEV_REAL_AUTH:-}" = "1" ] && USE_DEV_USER=0
[ "${DOXA_DEV_RUN_MIGRATIONS:-}" = "1" ] && RUN_MIGRATIONS=1

# Generated docs always use *.localhost in development. The tunnel changes only
# how the dashboard and API are reached; it never owns docs hostnames.
DOXA_DEV_HOSTNAME="${DOXA_DEV_HOSTNAME:-dev.doxa.so}"
if [ "$WITH_TUNNEL" -eq 1 ]; then
  DOXA_API_BASE_URL="${DOXA_API_BASE_URL:-https://${DOXA_DEV_HOSTNAME}}"
  DOXA_DASHBOARD_BASE_URL="${DOXA_DASHBOARD_BASE_URL:-https://${DOXA_DEV_HOSTNAME}}"
else
  DOXA_API_BASE_URL="${DOXA_API_BASE_URL:-http://localhost:8787}"
  DOXA_DASHBOARD_BASE_URL="${DOXA_DASHBOARD_BASE_URL:-http://localhost:3001}"
fi
DOXA_DOCS_BASE_DOMAIN="localhost"
export DOXA_API_BASE_URL DOXA_DASHBOARD_BASE_URL DOXA_DOCS_BASE_DOMAIN

prefix_stream() {
  local name="$1"
  local color="$2"

  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s[%s]%s %s%s%s %s\n' "$color" "$name" "$RESET" "$DIM" "$(date '+%H:%M:%S')" "$RESET" "$line"
  done
}

start_service() {
  local name="$1"
  local color="$2"
  local command="$3"
  local docs_content_token="${4:-}"
  local exit_file="${TMP_DIR}/${name}.exit"

  log "starting ${name}: ${command}"

  (
    set +e
    if [ -n "$docs_content_token" ]; then
      DOXA_DOCS_CONTENT_TOKEN="$docs_content_token" \
        bash -c "$command" > >(prefix_stream "$name" "$color") 2>&1 &
    else
      bash -c "$command" > >(prefix_stream "$name" "$color") 2>&1 &
    fi
    local service_pid=$!

    trap 'terminate_process_tree "$service_pid"; wait "$service_pid" >/dev/null 2>&1' INT TERM EXIT

    wait "$service_pid"
    local status=$?

    trap - INT TERM EXIT
    printf '%s\n' "$status" > "$exit_file"
    exit "$status"
  ) &

  PIDS+=("$!")
  NAMES+=("$name")
  SERVICE_COUNT=$((SERVICE_COUNT + 1))
}

cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi

  CLEANED_UP=1

  if [ "$SERVICE_COUNT" -gt 0 ]; then
    log "stopping foreground dev services..."

    for pid in "${PIDS[@]}"; do
      terminate_process_tree "$pid"
    done

    for pid in "${PIDS[@]}"; do
      wait "$pid" >/dev/null 2>&1 || true
    done
  fi

  if [ "$DB_STARTED" -eq 1 ] && [ "$STOP_DB_ON_EXIT" -eq 1 ]; then
    log "stopping Docker Compose services..."
    (cd "$ROOT_DIR" && docker compose down)
  elif [ "$DB_STARTED" -eq 1 ]; then
    log "Postgres was left running. Stop it with: pnpm db:local:down"
  fi

  rm -rf "$TMP_DIR"
}

trap cleanup EXIT INT TERM

preflight() {
  command_exists pnpm || fail "pnpm is required."
  command_exists lsof || fail "lsof is required to detect an existing local dev stack."
  command_exists pgrep || fail "pgrep is required to stop local service process trees."
  check_dev_ports

  if [ "$WITH_AGENT" -eq 1 ]; then
    command_exists curl || fail "curl is required to verify the local agent container."
    command_exists node || fail "node is required to prepare the local generation worker."
    validate_agent_config
  fi

  if [ "$WITH_RENDERER" -eq 1 ]; then
    command_exists node || fail "node is required to generate the local docs runtime token."
    [ "$WITH_DOCS" -eq 1 ] || fail "The shared docs renderer requires the docs runtime."
    [ -f "${DOCS_RENDERER_DIR}/package.json" ] \
      || fail "Shared docs renderer not found at ${DOCS_RENDERER_DIR}. Set DOXA_DOCS_RENDERER_DIR to the docs-template checkout."
  fi

  if [ "$WITH_DB" -eq 1 ]; then
    command_exists docker || fail "docker is required for local Postgres."
    docker info >/dev/null 2>&1 || fail "Docker is not running."
  fi

  if [ "$WITH_TUNNEL" -eq 1 ]; then
    command_exists cloudflared || fail "cloudflared is required for --tunnel. Install it or rerun with --no-tunnel."

    if [ ! -f "${DOXA_DEV_TUNNEL_ENV_FILE:-${ROOT_DIR}/infra/cloudflared/dev.env}" ]; then
      fail "Missing local tunnel environment file. Run: cp infra/cloudflared/dev.env.example infra/cloudflared/dev.env && pnpm dev:tunnel:setup doxa-local-dev"
    fi
  fi

  if [ ! -f "${DOXA_DEV_VARS_FILE:-${ROOT_DIR}/apps/api/.dev.vars}" ]; then
    warn "apps/api/.dev.vars is missing. Copy apps/api/.dev.vars.example before testing auth or generation secrets."
  fi

  if [ ! -f "${ROOT_DIR}/apps/web/.env.local" ]; then
    warn "apps/web/.env.local is missing. Copy apps/web/.env.local.example if the web app needs local env overrides."
  fi
}

prepare_docs_renderer() {
  DOCS_CONTENT_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  [ "${#DOCS_CONTENT_TOKEN}" -eq 64 ] || fail "Could not generate the local docs runtime token."

  DOCS_RUNTIME_ENV_FILE="${TMP_DIR}/docs-runtime.env"
  (umask 077 && printf 'DOCS_CONTENT_TOKEN=%s\n' "$DOCS_CONTENT_TOKEN" > "$DOCS_RUNTIME_ENV_FILE")

  export DOCS_RUNTIME_ENV_FILE
  export DOCS_RENDERER_DIR
}

dev_var_count() {
  local name="$1"
  local vars_file="$2"
  awk -v name="$name" '$0 ~ "^[[:space:]]*" name "[[:space:]]*=" {count += 1} END {print count + 0}' "$vars_file"
}

dev_var_value() {
  local name="$1"
  local vars_file="$2"
  awk -v name="$name" '
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "\047" && substr(value, length(value), 1) == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
    }
    END {print value}
  ' "$vars_file"
}

is_placeholder_key() {
  case "$1" in
    "" | your_key | replace-with-*-api-key) return 0 ;;
  esac
  return 1
}

# The generation worker reads DOXA_MODEL_PROVIDER from its wrangler.json vars.
configured_model_provider() {
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(config.vars?.DOXA_MODEL_PROVIDER?.trim() || "openrouter");
  ' "${ROOT_DIR}/apps/agent-worker/wrangler.json"
}

validate_agent_config() {
  local vars_file="${DOXA_DEV_VARS_FILE:-${ROOT_DIR}/apps/api/.dev.vars}"
  local provider
  local required_key
  local provider_label
  local key_name
  local key_count

  if [ ! -f "$vars_file" ]; then
    fail "Missing apps/api/.dev.vars. Copy apps/api/.dev.vars.example and configure the API key of the model provider."
  fi

  provider="$(configured_model_provider)"
  case "$provider" in
    openrouter)
      required_key="OPENROUTER_API_KEY"
      provider_label="OpenRouter"
      ;;
    anthropic)
      required_key="ANTHROPIC_API_KEY"
      provider_label="Anthropic"
      ;;
    *)
      fail "DOXA_MODEL_PROVIDER \"${provider}\" in apps/agent-worker/wrangler.json is not supported. Use openrouter or anthropic."
      ;;
  esac

  for key_name in OPENROUTER_API_KEY ANTHROPIC_API_KEY; do
    key_count="$(dev_var_count "$key_name" "$vars_file")"
    if [ "$key_count" -gt 1 ] || { [ "$key_name" = "$required_key" ] && [ "$key_count" -ne 1 ]; }; then
      fail "${key_name} must be defined exactly once in apps/api/.dev.vars; found ${key_count}."
    fi
  done

  LOCAL_OPENROUTER_API_KEY="$(dev_var_value OPENROUTER_API_KEY "$vars_file")"
  LOCAL_ANTHROPIC_API_KEY="$(dev_var_value ANTHROPIC_API_KEY "$vars_file")"

  local required_value="$LOCAL_OPENROUTER_API_KEY"
  [ "$required_key" = "ANTHROPIC_API_KEY" ] && required_value="$LOCAL_ANTHROPIC_API_KEY"
  if is_placeholder_key "$required_value"; then
    fail "${required_key} in apps/api/.dev.vars is still a placeholder. Configure a real ${provider_label} API key."
  fi
}

prepare_agent_worker() {
  local source_config="${ROOT_DIR}/apps/agent-worker/wrangler.json"
  local worker_dir="${TMP_DIR}/agent-worker"

  [ -f "$source_config" ] || fail "Missing agent worker configuration at ${source_config}."
  if is_placeholder_key "$LOCAL_OPENROUTER_API_KEY" && is_placeholder_key "$LOCAL_ANTHROPIC_API_KEY"; then
    fail "No local model provider API key was prepared."
  fi

  mkdir -p "$worker_dir"
  AGENT_WORKER_CONFIG_FILE="${worker_dir}/wrangler.json"

  (
    umask 077
    node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const [sourcePath, outputPath] = process.argv.slice(1);
      const sourceDirectory = path.dirname(sourcePath);
      const config = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

      config.main = path.resolve(sourceDirectory, config.main);
      if (config.$schema) {
        config.$schema = path.resolve(sourceDirectory, config.$schema);
      }

      fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      });
    ' "$source_config" "$AGENT_WORKER_CONFIG_FILE"
    {
      is_placeholder_key "$LOCAL_OPENROUTER_API_KEY" ||
        printf 'OPENROUTER_API_KEY=%s\n' "$LOCAL_OPENROUTER_API_KEY"
      is_placeholder_key "$LOCAL_ANTHROPIC_API_KEY" ||
        printf 'ANTHROPIC_API_KEY=%s\n' "$LOCAL_ANTHROPIC_API_KEY"
    } > "${worker_dir}/.dev.vars"
  )

  LOCAL_OPENROUTER_API_KEY=""
  LOCAL_ANTHROPIC_API_KEY=""
  export AGENT_WORKER_CONFIG_FILE
}

# The email Worker consumes the email queue that the API produces. It runs in
# the API's wrangler dev process, so the queue and the EmailDeliveryApi service
# binding resolve locally. wrangler dev simulates its send_email binding: each
# email is logged and saved to a local file, never sent.
prepare_email_worker() {
  local source_config="${ROOT_DIR}/apps/email-worker/wrangler.json"
  local worker_dir="${TMP_DIR}/email-worker"

  [ -f "$source_config" ] || fail "Missing email worker configuration at ${source_config}."

  mkdir -p "$worker_dir"
  EMAIL_WORKER_CONFIG_FILE="${worker_dir}/wrangler.json"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [sourcePath, outputPath] = process.argv.slice(1);
    const sourceDirectory = path.dirname(sourcePath);
    const config = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

    config.main = path.resolve(sourceDirectory, config.main);
    if (config.$schema) {
      config.$schema = path.resolve(sourceDirectory, config.$schema);
    }

    fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  ' "$source_config" "$EMAIL_WORKER_CONFIG_FILE"
  export EMAIL_WORKER_CONFIG_FILE
}

wait_for_postgres() {
  local attempts=60

  log "waiting for Postgres to accept connections..."

  for _ in $(seq 1 "$attempts"); do
    if (cd "$ROOT_DIR" && docker compose exec -T postgres pg_isready -U doxa -d doxa >/dev/null 2>&1); then
      log "Postgres is ready on localhost:5432."
      return
    fi

    sleep 1
  done

  fail "Postgres did not become ready within ${attempts}s."
}

wait_for_agent() {
  # The agent container builds the agent and the spec-reader image first;
  # a cold Docker cache needs a few minutes for the image.
  local attempts=300

  log "waiting for the agent container to become healthy..."

  for _ in $(seq 1 "$attempts"); do
    if curl --fail --silent --max-time 1 http://localhost:8789/health >/dev/null 2>&1; then
      log "agent container is ready on localhost:8789."
      return
    fi

    sleep 1
  done

  fail "Agent container did not become ready within ${attempts}s. Check the [agent] logs above."
}

wait_for_http_service() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"
  local display_address="${4:-$url}"

  log "waiting for ${name} to become healthy..."

  for _ in $(seq 1 "$attempts"); do
    if curl --fail --silent --max-time 1 "$url" >/dev/null 2>&1; then
      log "${name} is ready on ${display_address}."
      return
    fi

    sleep 1
  done

  fail "${name} did not become ready within ${attempts}s. Check its service logs above."
}

# The thin Worker and the Node origin share two keys. Create them once, as
# local-only random values, in the edge Worker's .dev.vars.
prepare_api_edge_dev_vars() {
  local edge_vars_file="${DOXA_DEV_API_EDGE_VARS_FILE:-${ROOT_DIR}/apps/api-edge/.dev.vars}"
  [ -f "$edge_vars_file" ] && return

  command_exists node || fail "node is required to create apps/api-edge/.dev.vars."
  node -e '
    const { randomBytes } = require("node:crypto");
    const key = () => randomBytes(24).toString("hex");
    require("node:fs").writeFileSync(process.argv[1], `ORIGIN_SHARED_SECRET=${key()}\nBRIDGE_SHARED_SECRET=${key()}\n`, { mode: 0o600 });
  ' "$edge_vars_file"
  log "created apps/api-edge/.dev.vars with new local keys."
}

get_tunnel_health_url() {
  local env_file="${DOXA_DEV_TUNNEL_ENV_FILE:-${ROOT_DIR}/infra/cloudflared/dev.env}"
  local configured_hostname

  configured_hostname="$({
    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    printf '%s' "${DOXA_DEV_HOSTNAME:-dev.doxa.so}"
  })"

  printf 'https://%s/health' "$configured_hostname"
}

wait_for_tunnel() {
  local url
  local wait_seconds="${DOXA_DEV_TUNNEL_WAIT_SECONDS:-60}"
  local started_at=$SECONDS
  local deadline
  local probe_result=""
  local status_code="000"
  local time_to_first_byte="0"
  local total_time="0"
  local time_to_first_byte_ms=0
  local total_time_ms=0
  local attempt=0
  local reported_wait=0

  case "$wait_seconds" in
    "" | *[!0-9]*)
      fail "DOXA_DEV_TUNNEL_WAIT_SECONDS must be a positive integer."
      ;;
  esac
  [ "$wait_seconds" -gt 0 ] || fail "DOXA_DEV_TUNNEL_WAIT_SECONDS must be greater than zero."

  url="$(get_tunnel_health_url)"
  deadline=$((SECONDS + wait_seconds))
  log "waiting for Cloudflare Tunnel to become healthy at ${url}..."

  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))

    if probe_result="$(curl --silent --show-error --output /dev/null \
      --connect-timeout 2 --max-time 5 \
      --write-out '%{http_code}|%{time_starttransfer}|%{time_total}' \
      "$url" 2>/dev/null)"; then
      IFS='|' read -r status_code time_to_first_byte total_time <<< "$probe_result"

      case "$status_code" in
        2??)
          time_to_first_byte_ms="$(awk -v seconds="$time_to_first_byte" 'BEGIN { printf "%.0f", seconds * 1000 }')"
          total_time_ms="$(awk -v seconds="$total_time" 'BEGIN { printf "%.0f", seconds * 1000 }')"

          if [ "$time_to_first_byte_ms" -gt 2000 ]; then
            warn "Cloudflare Tunnel is responding slowly: HTTP ${status_code}, TTFB ${time_to_first_byte_ms}ms, total ${total_time_ms}ms. Check the [tunnel] transport logs."
          else
            log "Cloudflare Tunnel is ready: HTTP ${status_code}, TTFB ${time_to_first_byte_ms}ms, total ${total_time_ms}ms."
          fi
          return
          ;;
      esac
    elif [ -n "$probe_result" ]; then
      IFS='|' read -r status_code time_to_first_byte total_time <<< "$probe_result"
    fi

    if [ "$attempt" -eq 1 ]; then
      warn "Cloudflare Tunnel probe has not succeeded yet (HTTP ${status_code})."
    elif [ "$reported_wait" -eq 0 ] && [ $((SECONDS - started_at)) -ge 10 ]; then
      warn "Cloudflare Tunnel is still connecting after $((SECONDS - started_at))s (HTTP ${status_code})."
      reported_wait=1
    fi
    sleep 1
  done

  warn "Cloudflare Tunnel did not become healthy within ${wait_seconds}s. The local stack will stay running; check the [tunnel] logs and ${url}."
}

run_migrations() {
  log "running local database migrations..."
  (cd "$ROOT_DIR" && DATABASE_URL=postgresql://doxa:doxa@localhost:5432/doxa pnpm db:migrate)
}

monitor_services() {
  log "dev stack is running."
  log "web: http://localhost:3001"
  log "api: http://localhost:8787"

  if [ "$WITH_DOCS" -eq 1 ]; then
    log "docs content runtime: http://localhost:8788"
  fi

  if [ "$WITH_RENDERER" -eq 1 ]; then
    log "docs renderer: http://<project-slug>.localhost:3002"
  fi

  if [ "$WITH_MCP" -eq 1 ]; then
    log "mcp server: http://localhost:8791/mcp"
  fi

  if [ "$WITH_AGENT" -eq 1 ]; then
    log "agent container: http://localhost:8789"
    log "generation worker: local queue consumer and Workflow emulator"
  fi

  if [ "$WITH_TUNNEL" -eq 1 ]; then
    log "tunnel: see the tunnel log for the configured hostname."
  fi

  log "press Ctrl-C to stop foreground services."

  while true; do
    local index=0

    if [ "$SERVICE_COUNT" -gt 0 ]; then
      for pid in "${PIDS[@]}"; do
        if ! kill -0 "$pid" >/dev/null 2>&1; then
          local name="${NAMES[$index]}"
          local exit_file="${TMP_DIR}/${name}.exit"
          local status="unknown"

          if [ -f "$exit_file" ]; then
            status="$(cat "$exit_file")"
          fi

          fail "${name} exited with status ${status}."
        fi

        index=$((index + 1))
      done
    fi

    sleep 1
  done
}

cd "$ROOT_DIR"

preflight

if [ "$WITH_AGENT" -eq 1 ]; then
  prepare_agent_worker
fi

prepare_email_worker

if [ "$WITH_RENDERER" -eq 1 ]; then
  prepare_docs_renderer
fi

log "booting Doxa local development environment..."

if [ "$WITH_DB" -eq 1 ]; then
  log "starting Docker Postgres..."
  docker compose up -d postgres
  DB_STARTED=1
  start_service "postgres" "$GREEN" "docker compose logs -f --since=30s postgres"
  wait_for_postgres

  if [ "$RUN_MIGRATIONS" -eq 1 ]; then
    run_migrations
  else
    log "skipping migrations. Run with --migrate when schema setup is needed."
  fi
fi

if [ "$WITH_AGENT" -eq 1 ]; then
  start_service "agent" "$YELLOW" "pnpm --filter @doxahq/agent-container dev"
  wait_for_agent
fi

# With --api-node, the thin doxa-api Worker takes the API Worker's place in
# the dev process, so the agent and email Workers bind to it as before, and
# the API itself runs as the Node origin.
API_WRANGLER_CONFIG="wrangler.json"
if [ "$API_RUNTIME" = "node" ]; then
  API_WRANGLER_CONFIG="../api-edge/wrangler.json"
  prepare_api_edge_dev_vars
  if [ "$WITH_DB" -eq 1 ]; then
    log "starting Docker Valkey..."
    docker compose up -d valkey
  else
    warn "--no-db: the Node origin expects Valkey at ${VALKEY_URL:-redis://localhost:6379}."
  fi
  start_service "origin" "$BLUE" "pnpm --filter @doxahq/api dev:node"
  wait_for_http_service "API origin" "http://localhost:8786/health" 90 "localhost:8786"
fi
export API_WRANGLER_CONFIG

if [ "$WITH_AGENT" -eq 1 ]; then
  start_service "platform" "$BLUE" 'pnpm --filter @doxahq/api exec wrangler dev --config "$API_WRANGLER_CONFIG" --config "$AGENT_WORKER_CONFIG_FILE" --config "$EMAIL_WORKER_CONFIG_FILE" --port 8787 --inspector-port 9230 --persist-to ../../.wrangler/state'
else
  start_service "api" "$BLUE" 'pnpm --filter @doxahq/api exec wrangler dev --config "$API_WRANGLER_CONFIG" --config "$EMAIL_WORKER_CONFIG_FILE" --port 8787 --inspector-port 9230 --persist-to ../../.wrangler/state'
fi

# The MCP Worker reaches the API through service bindings (token checks and
# actions), so it starts after the API. Its protected resource metadata answers
# without a token once the Worker is up.
if [ "$WITH_MCP" -eq 1 ]; then
  start_service "mcp" "$MAGENTA" "pnpm --filter @doxahq/mcp dev"
  wait_for_http_service "MCP server" "http://localhost:8791/.well-known/oauth-protected-resource/mcp" 90 "localhost:8791"
fi

if [ "$WITH_DOCS" -eq 1 ]; then
  if [ "$WITH_RENDERER" -eq 1 ]; then
    start_service "docs" "$MAGENTA" 'pnpm --filter @doxahq/docs-runtime exec wrangler dev --port 8788 --inspector-port 9231 --persist-to ../../.wrangler/state --env-file "$DOCS_RUNTIME_ENV_FILE"'
    wait_for_http_service "docs content runtime" "http://localhost:8788" 90 "localhost:8788"
  else
    start_service "docs" "$MAGENTA" "pnpm dev:docs"
  fi
fi

if [ "$WITH_RENDERER" -eq 1 ]; then
  start_service "try" "$MAGENTA" 'pnpm --filter @doxahq/try-proxy dev:gateway --env-file "$DOCS_RUNTIME_ENV_FILE" --var DOXA_DOCS_CONTENT_WORKER_URL:http://localhost:8788'
  start_service "renderer" "$GREEN" 'DOXA_DOCS_LOCAL_PLATFORM_DEV=1 DOXA_DOCS_CONTENT_WORKER_URL=http://localhost:8788 DOXA_DEPLOY_TARGET=cloudflare DOXA_API_BASE_URL="$DOXA_API_BASE_URL" DOXA_DASHBOARD_BASE_URL="$DOXA_DASHBOARD_BASE_URL" DOXA_DOCS_BASE_DOMAIN="$DOXA_DOCS_BASE_DOMAIN" pnpm --dir "$DOCS_RENDERER_DIR" exec vite dev --host 0.0.0.0 --port 3002' "$DOCS_CONTENT_TOKEN"
  wait_for_http_service "docs renderer" "http://localhost:3002/health.json" 120 "localhost:3002"
fi

if [ "$WITH_RENDERER" -eq 1 ] && [ "$USE_DEV_USER" -eq 1 ]; then
  start_service "web" "$CYAN" 'VITE_API_BASE_URL="$DOXA_API_BASE_URL" VITE_DOCS_BASE_DOMAIN="$DOXA_DOCS_BASE_DOMAIN" VITE_DOCS_RENDERER_BASE_URL=http://localhost:3002 VITE_DOCS_RUNTIME_URL=http://localhost:8788 VITE_DEV_USER_ID="${VITE_DEV_USER_ID:-local-dev-user}" pnpm dev:web'
elif [ "$WITH_RENDERER" -eq 1 ]; then
  start_service "web" "$CYAN" 'VITE_API_BASE_URL="$DOXA_API_BASE_URL" VITE_DOCS_BASE_DOMAIN="$DOXA_DOCS_BASE_DOMAIN" VITE_DOCS_RENDERER_BASE_URL=http://localhost:3002 VITE_DOCS_RUNTIME_URL=http://localhost:8788 pnpm dev:web'
elif [ "$USE_DEV_USER" -eq 1 ]; then
  start_service "web" "$CYAN" 'VITE_DEV_USER_ID="${VITE_DEV_USER_ID:-local-dev-user}" pnpm dev:web'
else
  start_service "web" "$CYAN" "pnpm dev:web"
fi

if [ "$WITH_TUNNEL" -eq 1 ]; then
  start_service "tunnel" "$WHITE" "pnpm dev:tunnel"
  wait_for_tunnel
fi

monitor_services
