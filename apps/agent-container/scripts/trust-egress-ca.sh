#!/bin/sh
# Entrypoint of the agent container image.
#
# With HTTPS interception, the egress gate of the Worker answers every HTTPS
# request with a certificate of the Cloudflare containers CA. The runtime puts
# that CA in the container at start, so the image cannot include it. When the
# file is there, Node and git trust it next to the normal certificate store.
# Without it (local Docker, the security lab), nothing changes.
set -eu

egress_ca="${DOXA_EGRESS_CA_FILE:-/etc/cloudflare/certs/cloudflare-containers-ca.crt}"
system_ca="${DOXA_SYSTEM_CA_FILE:-/etc/ssl/certs/ca-certificates.crt}"

if [ -r "$egress_ca" ]; then
  bundle="$(mktemp "${TMPDIR:-/tmp}/doxa-ca-bundle.XXXXXX")"
  cat "$system_ca" "$egress_ca" > "$bundle"
  # Node adds this file to its own store. git replaces its store with this
  # file, so it gets the full bundle.
  export NODE_EXTRA_CA_CERTS="$egress_ca"
  export GIT_SSL_CAINFO="$bundle"
fi

exec "$@"
