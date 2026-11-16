#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DOXA_DEV_TUNNEL_ENV_FILE:-${ROOT_DIR}/infra/cloudflared/dev.env}"
CONFIG_DIR="${DOXA_DEV_TUNNEL_CONFIG_DIR:-${ROOT_DIR}/.cloudflared}"
CONFIG_FILE="${CONFIG_DIR}/dev.yml"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed or is not on PATH." >&2
  echo "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
fi

# Older releases trust the compromised emSign intermediate certificates.
CLOUDFLARED_MIN_VERSION="2026.10.3"
CLOUDFLARED_VERSION="$(cloudflared --version | awk '{print $3}')"
if [ "$(printf '%s\n' "${CLOUDFLARED_MIN_VERSION}" "${CLOUDFLARED_VERSION}" | sort -V | head -n1)" != "${CLOUDFLARED_MIN_VERSION}" ]; then
  echo "cloudflared ${CLOUDFLARED_VERSION} is too old. Upgrade to ${CLOUDFLARED_MIN_VERSION} or later (brew upgrade cloudflared)." >&2
  exit 1
fi

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

: "${CLOUDFLARED_TUNNEL_ID:?Set CLOUDFLARED_TUNNEL_ID in infra/cloudflared/dev.env}"

DOXA_DEV_HOSTNAME="${DOXA_DEV_HOSTNAME:-dev.doxa.so}"
DOXA_WEB_ORIGIN="${DOXA_WEB_ORIGIN:-http://localhost:3001}"
DOXA_API_ORIGIN="${DOXA_API_ORIGIN:-http://localhost:8787}"
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
CLOUDFLARED_CREDENTIALS_FILE="${CLOUDFLARED_CREDENTIALS_FILE:-${HOME}/.cloudflared/${CLOUDFLARED_TUNNEL_ID}.json}"

case "$CLOUDFLARED_PROTOCOL" in
  auto | http2 | quic)
    ;;
  *)
    echo "CLOUDFLARED_PROTOCOL must be one of: auto, http2, quic." >&2
    exit 1
    ;;
esac

if [ ! -f "${CLOUDFLARED_CREDENTIALS_FILE}" ]; then
  echo "Cloudflare Tunnel credentials file not found:" >&2
  echo "  ${CLOUDFLARED_CREDENTIALS_FILE}" >&2
  echo "Run 'pnpm dev:tunnel:setup doxa-dev' to create a locally-managed tunnel and write infra/cloudflared/dev.env." >&2
  exit 1
fi

mkdir -p "${CONFIG_DIR}"

cat > "${CONFIG_FILE}" <<YAML
tunnel: ${CLOUDFLARED_TUNNEL_ID}
credentials-file: ${CLOUDFLARED_CREDENTIALS_FILE}
protocol: ${CLOUDFLARED_PROTOCOL}

ingress:
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/api/auth.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/sign-in/.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/me$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/github.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/projects.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/jobs.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/internal.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/health.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/oauth/(authorize|token|register)$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/\.well-known/oauth-authorization-server$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/agent-access.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/approval-requests.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/approval-settings.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/teams.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/team-invites.*$
    service: ${DOXA_API_ORIGIN}
  # Not /email: the web app serves /email/unsubscribe, and the API's POST
  # /email/unsubscribe shares the path. A tunnel route cannot split by method.
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/email-preferences.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    path: ^/billing.*$
    service: ${DOXA_API_ORIGIN}
  - hostname: ${DOXA_DEV_HOSTNAME}
    service: ${DOXA_WEB_ORIGIN}
  - service: http_status:404
YAML

echo "Starting Cloudflare Tunnel with ${CONFIG_FILE}"
echo "  transport -> ${CLOUDFLARED_PROTOCOL}"
echo "  ${DOXA_DEV_HOSTNAME} API -> ${DOXA_API_ORIGIN}"
echo "  ${DOXA_DEV_HOSTNAME} web -> ${DOXA_WEB_ORIGIN}"

exec cloudflared tunnel --config "${CONFIG_FILE}" run "${CLOUDFLARED_TUNNEL_ID}"
