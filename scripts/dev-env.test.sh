#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/doxa-dev-env-test.XXXXXX")"
FAKE_BIN="${TMP_DIR}/bin"
DEV_ENV_PID=""

cleanup() {
  if [ -n "$DEV_ENV_PID" ]; then
    kill -TERM "$DEV_ENV_PID" >/dev/null 2>&1 || true
    wait "$DEV_ENV_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

mkdir -p "$FAKE_BIN"
cat > "${FAKE_BIN}/pnpm" <<'SCRIPT'
#!/usr/bin/env bash
if [ -n "${DOXA_DEV_TEST_ENV_LOG:-}" ]; then
  printf '%s|%s\n' "${DOXA_DOCS_CONTENT_TOKEN:+token}" "$*" >> "$DOXA_DEV_TEST_ENV_LOG"
  if [[ "$*" == *'apps/docs-template exec vite dev'* ]]; then
    printf 'renderer-env|%s|%s|%s\n' \
      "${DOXA_API_BASE_URL:-}" \
      "${DOXA_DASHBOARD_BASE_URL:-}" \
      "${DOXA_DOCS_BASE_DOMAIN:-}" >> "$DOXA_DEV_TEST_ENV_LOG"
  fi
  if [[ "$*" == *'dev:web'* ]]; then
    printf 'web-env|%s|%s|%s|%s\n' \
      "${VITE_API_BASE_URL:-}" \
      "${VITE_DOCS_BASE_DOMAIN:-}" \
      "${VITE_DOCS_RENDERER_BASE_URL:-}" \
      "${VITE_DOCS_RUNTIME_URL:-}" >> "$DOXA_DEV_TEST_ENV_LOG"
  fi
  if [[ "$*" == *'--config wrangler.json --config '* ]] \
    && [ -n "${AGENT_WORKER_CONFIG_FILE:-}" ] \
    && [ -f "$AGENT_WORKER_CONFIG_FILE" ] \
    && [ -f "$(dirname "$AGENT_WORKER_CONFIG_FILE")/.dev.vars" ]; then
    worker_main="$(node -e '
      const fs = require("node:fs");
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(config.main);
    ' "$AGENT_WORKER_CONFIG_FILE")"
    worker_secret_names="$(awk -F= '/^[A-Z0-9_]+=/ { print $1 }' \
      "$(dirname "$AGENT_WORKER_CONFIG_FILE")/.dev.vars" | paste -sd, -)"
    printf 'worker-config|%s|%s\n' "$worker_main" "$worker_secret_names" >> "$DOXA_DEV_TEST_ENV_LOG"
  fi
fi
trap 'exit 0' INT TERM
while true; do
  sleep 1
done
SCRIPT
chmod +x "${FAKE_BIN}/pnpm"

cat > "${FAKE_BIN}/curl" <<'SCRIPT'
#!/usr/bin/env bash
for argument in "$@"; do
  if [[ "$argument" == *'%{http_code}'* ]]; then
    if [ "${DOXA_DEV_TEST_CURL_MODE:-healthy}" = "unhealthy" ]; then
      printf '530|0.010000|0.012000'
    else
      printf '200|0.123456|0.125678'
    fi
    break
  fi
done
exit 0
SCRIPT
chmod +x "${FAKE_BIN}/curl"

cat > "${FAKE_BIN}/cloudflared" <<'SCRIPT'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "cloudflared version ${DOXA_DEV_TEST_CLOUDFLARED_VERSION:-2026.10.3} (built 2026-10-21T10:51:09Z)"
  exit 0
fi
if [ -n "${DOXA_DEV_TEST_CLOUDFLARED_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$DOXA_DEV_TEST_CLOUDFLARED_LOG"
fi
exit 0
SCRIPT
chmod +x "${FAKE_BIN}/cloudflared"

cat > "${FAKE_BIN}/docker" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
chmod +x "${FAKE_BIN}/docker"

cat > "${FAKE_BIN}/lsof" <<'SCRIPT'
#!/usr/bin/env bash
for argument in "$@"; do
  if [ -n "${DOXA_DEV_TEST_BUSY_PORT:-}" ] && [ "$argument" = "-iTCP:${DOXA_DEV_TEST_BUSY_PORT}" ]; then
    printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n'
    printf 'node 4242 test 1u IPv4 0 0t0 TCP *:%s (LISTEN)\n' "$DOXA_DEV_TEST_BUSY_PORT"
    exit 0
  fi
done
exit 1
SCRIPT
chmod +x "${FAKE_BIN}/lsof"

run_dev_env() {
  local output_file="$1"
  shift

  PATH="${FAKE_BIN}:${PATH}" bash "${ROOT_DIR}/scripts/dev-env.sh" \
    --no-db --no-docs --no-tunnel "$@" > "$output_file" 2>&1 &
  DEV_ENV_PID=$!

  for _ in $(seq 1 100); do
    if grep -Fq "[dev-env] starting web:" "$output_file"; then
      break
    fi
    if ! kill -0 "$DEV_ENV_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 0.05
  done

  kill -TERM "$DEV_ENV_PID" >/dev/null 2>&1 || true
  wait "$DEV_ENV_PID" >/dev/null 2>&1 || true
  DEV_ENV_PID=""
}

run_dev_env_with_docs() {
  local output_file="$1"
  shift

  PATH="${FAKE_BIN}:${PATH}" bash "${ROOT_DIR}/scripts/dev-env.sh" \
    --no-db --no-agent --no-tunnel "$@" > "$output_file" 2>&1 &
  DEV_ENV_PID=$!

  for _ in $(seq 1 100); do
    if grep -Fq "[dev-env] starting web:" "$output_file"; then
      break
    fi
    if ! kill -0 "$DEV_ENV_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 0.05
  done

  kill -TERM "$DEV_ENV_PID" >/dev/null 2>&1 || true
  wait "$DEV_ENV_PID" >/dev/null 2>&1 || true
  DEV_ENV_PID=""
}

run_dev_env_with_tunnel() {
  local output_file="$1"
  local tunnel_env_file="$2"
  local curl_mode="${3:-healthy}"
  local wait_seconds="${4:-60}"
  local docs_mode="${5:-without-docs}"
  local completion_marker="Cloudflare Tunnel is ready:"
  local dev_args=(--no-db --no-agent)

  if [ "$docs_mode" != "with-docs" ]; then
    dev_args+=(--no-docs)
  fi

  if [ "$curl_mode" = "unhealthy" ]; then
    completion_marker="The local stack will stay running"
  fi

  DOXA_DEV_TEST_CURL_MODE="$curl_mode" \
  DOXA_DEV_TUNNEL_ENV_FILE="$tunnel_env_file" \
  DOXA_DEV_TUNNEL_WAIT_SECONDS="$wait_seconds" \
  PATH="${FAKE_BIN}:${PATH}" \
    bash "${ROOT_DIR}/scripts/dev-env.sh" \
      "${dev_args[@]}" > "$output_file" 2>&1 &
  DEV_ENV_PID=$!

  for _ in $(seq 1 100); do
    if grep -Fq "$completion_marker" "$output_file"; then
      break
    fi
    if ! kill -0 "$DEV_ENV_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 0.05
  done

  kill -TERM "$DEV_ENV_PID" >/dev/null 2>&1 || true
  wait "$DEV_ENV_PID" >/dev/null 2>&1 || true
  DEV_ENV_PID=""
}

default_output="${TMP_DIR}/default.log"
default_service_env="${TMP_DIR}/default-service-env.log"
DOXA_DEV_TEST_ENV_LOG="$default_service_env" run_dev_env "$default_output"

if ! grep -Fq '[dev-env] starting platform: pnpm --filter @doxahq/api exec wrangler dev --config "$API_WRANGLER_CONFIG" --config "$AGENT_WORKER_CONFIG_FILE" --config "$EMAIL_WORKER_CONFIG_FILE" --port 8787 --inspector-port 9230 --persist-to ../../.wrangler/state' "$default_output"; then
  echo "default dev environment did not start the API and generation worker together" >&2
  cat "$default_output" >&2
  exit 1
fi
if grep -Fq "[dev-env] starting api:" "$default_output"; then
  echo "default dev environment unexpectedly started the standalone API worker" >&2
  cat "$default_output" >&2
  exit 1
fi
model_provider_key="$(node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const provider = config.vars?.DOXA_MODEL_PROVIDER?.trim() || "openrouter";
  process.stdout.write(provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY");
' "${ROOT_DIR}/apps/agent-worker/wrangler.json")"
if ! grep "^worker-config|${ROOT_DIR}/apps/agent-worker/src/index.ts|" "$default_service_env" | grep -Fq "$model_provider_key"; then
  echo "default dev environment did not isolate the generation worker config and secret" >&2
  cat "$default_service_env" >&2
  exit 1
fi
if ! grep -Fq "[dev-env] starting web: pnpm dev:web" "$default_output"; then
  echo "default dev environment did not start web with real auth" >&2
  cat "$default_output" >&2
  exit 1
fi
if grep -Fq "VITE_DEV_USER_ID" "$default_output"; then
  echo "default dev environment unexpectedly enabled the synthetic dev user" >&2
  exit 1
fi
if ! grep -Fq "[dev-env] starting agent: pnpm --filter @doxahq/agent-container dev" "$default_output"; then
  echo "default dev environment did not start the agent container" >&2
  cat "$default_output" >&2
  exit 1
fi
if ! grep -Fq "[dev-env] agent container is ready on localhost:8789." "$default_output"; then
  echo "default dev environment did not wait for the agent container" >&2
  cat "$default_output" >&2
  exit 1
fi

docs_output="${TMP_DIR}/docs.log"
docs_service_env="${TMP_DIR}/docs-service-env.log"
DOXA_DOCS_BASE_DOMAIN=docs.dev.doxa.so \
DOXA_DEV_TEST_ENV_LOG="$docs_service_env" \
  run_dev_env_with_docs "$docs_output"

if ! grep -Fq '[dev-env] starting docs: pnpm --filter @doxahq/docs-runtime exec wrangler dev --port 8788 --inspector-port 9231 --persist-to ../../.wrangler/state --env-file "$DOCS_RUNTIME_ENV_FILE"' "$docs_output"; then
  echo "default docs environment did not start the authenticated content runtime" >&2
  cat "$docs_output" >&2
  exit 1
fi
if grep -Fq -- '-- --env-file' "$docs_output"; then
  echo "docs runtime passed --env-file after Wrangler's argument separator" >&2
  cat "$docs_output" >&2
  exit 1
fi
if ! grep -Fq '[dev-env] starting renderer: DOXA_DOCS_LOCAL_PLATFORM_DEV=1 DOXA_DOCS_CONTENT_WORKER_URL=http://localhost:8788 DOXA_DEPLOY_TARGET=cloudflare DOXA_API_BASE_URL="$DOXA_API_BASE_URL" DOXA_DASHBOARD_BASE_URL="$DOXA_DASHBOARD_BASE_URL" DOXA_DOCS_BASE_DOMAIN="$DOXA_DOCS_BASE_DOMAIN" pnpm --dir "$DOCS_RENDERER_DIR" exec vite dev --host 0.0.0.0 --port 3002' "$docs_output"; then
  echo "default docs environment did not start the shared docs renderer" >&2
  cat "$docs_output" >&2
  exit 1
fi
if ! grep -Fq "token|--dir ${ROOT_DIR}/apps/docs-template exec vite dev --host 0.0.0.0 --port 3002" "$docs_service_env"; then
  echo "default docs environment did not use the monorepo docs-template path" >&2
  cat "$docs_service_env" >&2
  exit 1
fi
if ! grep -Fq "renderer-env|http://localhost:8787|http://localhost:3001|localhost" "$docs_service_env"; then
  echo "default docs environment did not keep generated docs on localhost" >&2
  cat "$docs_service_env" >&2
  exit 1
fi
if ! grep -Fq "web-env|http://localhost:8787|localhost|http://localhost:3002|http://localhost:8788" "$docs_service_env"; then
  echo "default web environment did not use the local docs renderer" >&2
  cat "$docs_service_env" >&2
  exit 1
fi
if ! grep -Fq "[dev-env] docs renderer is ready on localhost:3002." "$docs_output"; then
  echo "default docs environment did not wait for the shared docs renderer" >&2
  cat "$docs_output" >&2
  exit 1
fi
if grep -Fq "DOXA_DOCS_CONTENT_TOKEN=" "$docs_output"; then
  echo "docs runtime token was exposed in startup logs" >&2
  cat "$docs_output" >&2
  exit 1
fi
if [ "$(grep -c '^token|' "$docs_service_env")" -ne 1 ] \
  || ! grep -Fq 'token|--dir ' "$docs_service_env"; then
  echo "docs runtime token was not isolated to the renderer process" >&2
  cat "$docs_service_env" >&2
  exit 1
fi

no_renderer_output="${TMP_DIR}/no-renderer.log"
run_dev_env_with_docs "$no_renderer_output" --no-renderer

if grep -Fq "[dev-env] starting renderer:" "$no_renderer_output"; then
  echo "--no-renderer unexpectedly started the shared docs renderer" >&2
  cat "$no_renderer_output" >&2
  exit 1
fi

no_agent_output="${TMP_DIR}/no-agent.log"
run_dev_env "$no_agent_output" --no-agent

if grep -Fq "[dev-env] starting agent:" "$no_agent_output"; then
  echo "--no-agent unexpectedly started the agent container" >&2
  cat "$no_agent_output" >&2
  exit 1
fi
if ! grep -Fq '[dev-env] starting api: pnpm --filter @doxahq/api exec wrangler dev --config "$API_WRANGLER_CONFIG" --config "$EMAIL_WORKER_CONFIG_FILE"' "$no_agent_output"; then
  echo "--no-agent did not preserve the standalone API development path" >&2
  cat "$no_agent_output" >&2
  exit 1
fi
if grep -Fq "[dev-env] starting platform:" "$no_agent_output"; then
  echo "--no-agent unexpectedly started the generation worker" >&2
  cat "$no_agent_output" >&2
  exit 1
fi

if ! grep -Fq -- "--config wrangler.json --config" "$default_service_env"; then
  echo "default dev environment did not run the API Worker config" >&2
  cat "$default_service_env" >&2
  exit 1
fi

api_node_output="${TMP_DIR}/api-node.log"
api_node_service_env="${TMP_DIR}/api-node-service-env.log"
api_node_edge_vars="${TMP_DIR}/api-edge.dev.vars"
DOXA_DEV_API_EDGE_VARS_FILE="$api_node_edge_vars" DOXA_DEV_TEST_ENV_LOG="$api_node_service_env" \
  run_dev_env "$api_node_output" --no-agent --api-node

if ! grep -Fq "[dev-env] starting origin: pnpm --filter @doxahq/api dev:node" "$api_node_output"; then
  echo "--api-node did not start the Node origin" >&2
  cat "$api_node_output" >&2
  exit 1
fi
if ! grep -Fq -- "--config ../api-edge/wrangler.json --config" "$api_node_service_env"; then
  echo "--api-node did not run the thin Worker in place of the API Worker" >&2
  cat "$api_node_service_env" >&2
  exit 1
fi
if ! grep -q "^ORIGIN_SHARED_SECRET=[0-9a-f]\{48\}$" "$api_node_edge_vars" \
  || ! grep -q "^BRIDGE_SHARED_SECRET=[0-9a-f]\{48\}$" "$api_node_edge_vars"; then
  echo "--api-node did not create the shared local keys" >&2
  cat "$api_node_edge_vars" >&2
  exit 1
fi

dev_user_output="${TMP_DIR}/dev-user.log"
run_dev_env "$dev_user_output" --dev-user

if ! grep -Fq '[dev-env] starting web: VITE_DEV_USER_ID="${VITE_DEV_USER_ID:-local-dev-user}" pnpm dev:web' "$dev_user_output"; then
  echo "--dev-user did not enable the synthetic dev user" >&2
  cat "$dev_user_output" >&2
  exit 1
fi

tunnel_credentials="${TMP_DIR}/tunnel-credentials.json"
tunnel_env="${TMP_DIR}/tunnel.env"
touch "$tunnel_credentials"
cat > "$tunnel_env" <<VARS
CLOUDFLARED_TUNNEL_ID=test-tunnel-id
CLOUDFLARED_CREDENTIALS_FILE=${tunnel_credentials}
DOXA_DEV_HOSTNAME=tunnel-test.example
DOXA_WEB_ORIGIN=http://localhost:3001
DOXA_API_ORIGIN=http://localhost:8787
VARS

tunnel_output="${TMP_DIR}/tunnel.log"
run_dev_env_with_tunnel "$tunnel_output" "$tunnel_env"

if ! grep -Fq "[dev-env] waiting for Cloudflare Tunnel to become healthy at https://tunnel-test.example/health..." "$tunnel_output"; then
  echo "dev environment did not report the tunnel health endpoint" >&2
  cat "$tunnel_output" >&2
  exit 1
fi
if ! grep -Fq "[dev-env] Cloudflare Tunnel is ready: HTTP 200, TTFB 123ms, total 126ms." "$tunnel_output"; then
  echo "dev environment did not report tunnel latency" >&2
  cat "$tunnel_output" >&2
  exit 1
fi

tunnel_docs_output="${TMP_DIR}/tunnel-docs.log"
tunnel_docs_service_env="${TMP_DIR}/tunnel-docs-service-env.log"
DOXA_DEV_HOSTNAME=tunnel-test.example \
DOXA_DEV_TEST_ENV_LOG="$tunnel_docs_service_env" \
  run_dev_env_with_tunnel "$tunnel_docs_output" "$tunnel_env" healthy 60 with-docs

if ! grep -Fq "renderer-env|https://tunnel-test.example|https://tunnel-test.example|localhost" "$tunnel_docs_service_env"; then
  echo "tunnel docs environment did not keep generated docs on localhost" >&2
  cat "$tunnel_docs_service_env" >&2
  exit 1
fi
if ! grep -Fq "web-env|https://tunnel-test.example|localhost|http://localhost:3002|http://localhost:8788" "$tunnel_docs_service_env"; then
  echo "tunnel web environment did not use the local docs renderer" >&2
  cat "$tunnel_docs_service_env" >&2
  exit 1
fi

unhealthy_tunnel_output="${TMP_DIR}/unhealthy-tunnel.log"
run_dev_env_with_tunnel "$unhealthy_tunnel_output" "$tunnel_env" unhealthy 1

if ! grep -Fq "[dev-env] Cloudflare Tunnel did not become healthy within 1s. The local stack will stay running" "$unhealthy_tunnel_output"; then
  echo "dev environment stopped instead of preserving the stack after a tunnel readiness timeout" >&2
  cat "$unhealthy_tunnel_output" >&2
  exit 1
fi
if ! grep -Fq "[dev-env] dev stack is running." "$unhealthy_tunnel_output"; then
  echo "dev environment did not enter service monitoring after a tunnel readiness timeout" >&2
  cat "$unhealthy_tunnel_output" >&2
  exit 1
fi

tunnel_script_output="${TMP_DIR}/tunnel-script.log"
tunnel_config_dir="${TMP_DIR}/cloudflared-config"
cloudflared_args="${TMP_DIR}/cloudflared-args.log"
DOXA_DEV_TUNNEL_ENV_FILE="$tunnel_env" \
DOXA_DEV_TUNNEL_CONFIG_DIR="$tunnel_config_dir" \
DOXA_DEV_TEST_CLOUDFLARED_LOG="$cloudflared_args" \
PATH="${FAKE_BIN}:${PATH}" \
  bash "${ROOT_DIR}/scripts/dev-tunnel.sh" > "$tunnel_script_output" 2>&1

if ! grep -Fq "protocol: http2" "${tunnel_config_dir}/dev.yml"; then
  echo "tunnel script did not default to HTTP/2" >&2
  cat "${tunnel_config_dir}/dev.yml" >&2
  exit 1
fi
if ! grep -Fq "transport -> http2" "$tunnel_script_output"; then
  echo "tunnel script did not report the selected transport" >&2
  cat "$tunnel_script_output" >&2
  exit 1
fi
if ! grep -Fq "tunnel --config ${tunnel_config_dir}/dev.yml run test-tunnel-id" "$cloudflared_args"; then
  echo "tunnel script did not invoke cloudflared with the generated config" >&2
  cat "$cloudflared_args" >&2
  exit 1
fi

invalid_protocol_output="${TMP_DIR}/invalid-protocol.log"
if CLOUDFLARED_PROTOCOL=invalid \
  DOXA_DEV_TUNNEL_ENV_FILE="$tunnel_env" \
  DOXA_DEV_TUNNEL_CONFIG_DIR="$tunnel_config_dir" \
  PATH="${FAKE_BIN}:${PATH}" \
    bash "${ROOT_DIR}/scripts/dev-tunnel.sh" > "$invalid_protocol_output" 2>&1; then
  echo "tunnel script unexpectedly accepted an invalid transport" >&2
  exit 1
fi
if ! grep -Fq "CLOUDFLARED_PROTOCOL must be one of: auto, http2, quic." "$invalid_protocol_output"; then
  echo "tunnel script did not explain the invalid transport" >&2
  cat "$invalid_protocol_output" >&2
  exit 1
fi

old_cloudflared_output="${TMP_DIR}/old-cloudflared.log"
if DOXA_DEV_TEST_CLOUDFLARED_VERSION=2026.10.2 \
  DOXA_DEV_TUNNEL_ENV_FILE="$tunnel_env" \
  DOXA_DEV_TUNNEL_CONFIG_DIR="$tunnel_config_dir" \
  PATH="${FAKE_BIN}:${PATH}" \
    bash "${ROOT_DIR}/scripts/dev-tunnel.sh" > "$old_cloudflared_output" 2>&1; then
  echo "tunnel script unexpectedly started an outdated cloudflared" >&2
  exit 1
fi
if ! grep -Fq "cloudflared 2026.10.2 is too old. Upgrade to 2026.10.3 or later" "$old_cloudflared_output"; then
  echo "tunnel script did not explain the outdated cloudflared" >&2
  cat "$old_cloudflared_output" >&2
  exit 1
fi

docker_error_output="${TMP_DIR}/docker-error.log"
if PATH="${FAKE_BIN}:${PATH}" bash "${ROOT_DIR}/scripts/dev-env.sh" --no-tunnel > "$docker_error_output" 2>&1; then
  echo "dev environment unexpectedly started without Docker" >&2
  exit 1
fi
if ! grep -Fq "[dev-env] Docker is not running." "$docker_error_output"; then
  echo "missing Docker error was not reported" >&2
  cat "$docker_error_output" >&2
  exit 1
fi

busy_port_output="${TMP_DIR}/busy-port.log"
if DOXA_DEV_TEST_BUSY_PORT=3001 PATH="${FAKE_BIN}:${PATH}" \
  bash "${ROOT_DIR}/scripts/dev-env.sh" \
    --no-db --no-docs --no-agent --no-tunnel > "$busy_port_output" 2>&1; then
  echo "dev environment unexpectedly started while its web port was occupied" >&2
  exit 1
fi
if ! grep -Fq "web port 3001 is already in use by node (PID 4242). Stop the existing pnpm dev process before starting another stack." "$busy_port_output"; then
  echo "dev environment did not explain the occupied port" >&2
  cat "$busy_port_output" >&2
  exit 1
fi
if grep -Fq "unbound variable" "$docker_error_output"; then
  echo "cleanup referenced an empty service array after preflight failure" >&2
  cat "$docker_error_output" >&2
  exit 1
fi

duplicate_vars="${TMP_DIR}/duplicate.dev.vars"
cat > "$duplicate_vars" <<'VARS'
OPENROUTER_API_KEY=first-key
OPENROUTER_API_KEY=second-key
VARS
duplicate_output="${TMP_DIR}/duplicate.log"
if DOXA_DEV_VARS_FILE="$duplicate_vars" PATH="${FAKE_BIN}:${PATH}" \
  bash "${ROOT_DIR}/scripts/dev-env.sh" --no-db --no-docs --no-tunnel > "$duplicate_output" 2>&1; then
  echo "dev environment unexpectedly accepted duplicate OpenRouter keys" >&2
  exit 1
fi
if ! grep -Fq "OPENROUTER_API_KEY must be defined exactly once" "$duplicate_output"; then
  echo "duplicate OpenRouter key was not reported" >&2
  cat "$duplicate_output" >&2
  exit 1
fi

placeholder_vars="${TMP_DIR}/placeholder.dev.vars"
cat > "$placeholder_vars" <<'VARS'
OPENROUTER_API_KEY=your_key
ANTHROPIC_API_KEY=replace-with-anthropic-api-key
VARS
placeholder_output="${TMP_DIR}/placeholder.log"
if DOXA_DEV_VARS_FILE="$placeholder_vars" PATH="${FAKE_BIN}:${PATH}" \
  bash "${ROOT_DIR}/scripts/dev-env.sh" --no-db --no-docs --no-tunnel > "$placeholder_output" 2>&1; then
  echo "dev environment unexpectedly accepted a placeholder model provider key" >&2
  exit 1
fi
if ! grep -Fq "${model_provider_key} in apps/api/.dev.vars is still a placeholder" "$placeholder_output"; then
  echo "placeholder model provider key was not reported" >&2
  cat "$placeholder_output" >&2
  exit 1
fi

echo "dev-env service and auth mode tests passed"
