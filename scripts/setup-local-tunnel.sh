#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/infra/cloudflared/dev.env"
TUNNEL_NAME="${1:-doxa-local-dev}"
DOXA_DEV_HOSTNAME="${DOXA_DEV_HOSTNAME:-dev.doxa.so}"
DOXA_WEB_ORIGIN="${DOXA_WEB_ORIGIN:-http://localhost:3001}"
DOXA_API_ORIGIN="${DOXA_API_ORIGIN:-http://localhost:8787}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed or is not on PATH." >&2
  echo "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
fi

if [ ! -f "${HOME}/.cloudflared/cert.pem" ]; then
  echo "No cloudflared account certificate found at ${HOME}/.cloudflared/cert.pem."
  echo "Opening Cloudflare login. Complete it in the browser, then rerun this command if needed."
  cloudflared tunnel login
fi

echo "Creating locally-managed Cloudflare Tunnel: ${TUNNEL_NAME}"
CREATE_OUTPUT="$(cloudflared tunnel create "${TUNNEL_NAME}" 2>&1)"
echo "${CREATE_OUTPUT}"

TUNNEL_ID="$(printf '%s\n' "${CREATE_OUTPUT}" | sed -nE 's/.*Created tunnel .* with id ([0-9a-fA-F-]+).*/\1/p' | tail -n 1)"

if [ -z "${TUNNEL_ID}" ]; then
  echo "Could not parse tunnel ID from cloudflared output." >&2
  echo "If the tunnel already exists, run 'cloudflared tunnel list', copy its UUID, and update infra/cloudflared/dev.env manually." >&2
  exit 1
fi

CREDENTIALS_FILE="${HOME}/.cloudflared/${TUNNEL_ID}.json"

if [ ! -f "${CREDENTIALS_FILE}" ]; then
  echo "Expected credentials file was not created:" >&2
  echo "  ${CREDENTIALS_FILE}" >&2
  exit 1
fi

cat > "${ENV_FILE}" <<ENV
# Local Cloudflare Tunnel config for Doxa platform.
# This file is ignored by Git.
CLOUDFLARED_TUNNEL_ID=${TUNNEL_ID}
CLOUDFLARED_CREDENTIALS_FILE=${CREDENTIALS_FILE}
CLOUDFLARED_PROTOCOL=http2
DOXA_DEV_HOSTNAME=${DOXA_DEV_HOSTNAME}
DOXA_WEB_ORIGIN=${DOXA_WEB_ORIGIN}
DOXA_API_ORIGIN=${DOXA_API_ORIGIN}
ENV

echo "Wrote ${ENV_FILE}"
echo
echo "Route DNS to this tunnel with:"
echo "  cloudflared tunnel route dns ${TUNNEL_ID} ${DOXA_DEV_HOSTNAME}"
echo
echo "Then start the tunnel with:"
echo "  pnpm dev:tunnel"
