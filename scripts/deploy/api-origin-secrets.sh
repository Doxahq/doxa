#!/usr/bin/env bash
# Writes the secrets of the API origin on ECS to SSM Parameter Store, at
# /doxa/api/<environment>/<NAME>, as SecureString. The ECS task reads them at
# start. See infra/terraform/README.md.
#
# The secret names come from api_secret_names in the Terraform variables, so
# this script and the task definition always use the same list.
#
# Values are read without echo and never printed. They reach the AWS CLI
# through a temporary file that only this user can read and that is deleted
# right after the call, never on the command line: other users could see a
# command line in `ps`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_DIR="${ROOT_DIR}/infra/terraform/production"

ENVIRONMENT="production"
REGION="us-east-1"
TFVARS=""
LIST_ONLY=false
ASSUME_YES=false
OVERWRITE_NAMES=" "

# The shared keys between the edge Worker and the origin. The script makes
# them itself: nobody needs to know their values.
GENERATED_NAMES=" ORIGIN_SHARED_SECRET BRIDGE_SHARED_SECRET "
GENERATED_LENGTH=48
# SSM standard parameters hold at most 4 KB.
MAX_VALUE_BYTES=4096

usage() {
  cat <<'USAGE'
Usage: pnpm secrets:api:ecs [options]

Asks for each missing secret of the API origin and writes it to SSM.

Options:
  --list                 Show which secrets are set and which are missing. Change nothing.
  --overwrite NAME       Write only NAME, even if it is set (to rotate it). Repeat for more names.
                         The script then skips every other secret and does not check them.
  --environment NAME     Environment of the SSM path /doxa/api/NAME (default: production).
  --region REGION        AWS region (default: us-east-1).
  --tfvars PATH          Variables file with api_secret_names
                         (default: infra/terraform/production/terraform.tfvars, else its example).
  --yes                  Do not ask to confirm the AWS account.
  -h, --help             Show this help.

Value types:
  ORIGIN_SHARED_SECRET, BRIDGE_SHARED_SECRET   generated (48 random characters)
  *_PRIVATE_KEY                                 read from a file, for example a GitHub App .pem
  any other name                                typed or pasted, hidden
USAGE
}

fail() {
  echo "Error: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=true ;;
    --overwrite) [ $# -ge 2 ] || fail "--overwrite needs a NAME."; OVERWRITE_NAMES="${OVERWRITE_NAMES}$2 "; shift ;;
    --environment) [ $# -ge 2 ] || fail "--environment needs a NAME."; ENVIRONMENT="$2"; shift ;;
    --region) [ $# -ge 2 ] || fail "--region needs a REGION."; REGION="$2"; shift ;;
    --tfvars) [ $# -ge 2 ] || fail "--tfvars needs a PATH."; TFVARS="$2"; shift ;;
    --yes) ASSUME_YES=true ;;
    -h | --help) usage; exit 0 ;;
    *) fail "Unknown option $1. Run with --help." ;;
  esac
  shift
done

[[ "$ENVIRONMENT" =~ ^[a-z][a-z0-9-]{1,20}$ ]] || fail "--environment must be lowercase letters, digits and dashes."
PREFIX="/doxa/api/${ENVIRONMENT}"

if [ -z "$TFVARS" ]; then
  TFVARS="${TERRAFORM_DIR}/terraform.tfvars"
  [ -f "$TFVARS" ] || TFVARS="$(find "$TERRAFORM_DIR" -maxdepth 1 -name 'terraform.tfvars*.example' | head -n 1)"
fi
if [ -z "$TFVARS" ] || [ ! -f "$TFVARS" ]; then
  fail "No variables file with api_secret_names. Pass --tfvars PATH."
fi

# The quoted names inside `api_secret_names = [ ... ]`, without comments.
secret_names() {
  awk '
    /^[[:space:]]*api_secret_names[[:space:]]*=/ { inside = 1; next }
    inside && /^[[:space:]]*\]/ { exit }
    inside { sub(/#.*/, ""); while (match($0, /"[A-Z][A-Z0-9_]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); $0 = substr($0, RSTART + RLENGTH) } }
  ' "$1"
}

NAMES="$(secret_names "$TFVARS")"
[ -n "$NAMES" ] || fail "${TFVARS} has no api_secret_names."

# With --overwrite, work on those names only: no SSM check for the others.
TARGET_ONLY=false
if [ -n "${OVERWRITE_NAMES// /}" ]; then
  for name in $OVERWRITE_NAMES; do
    case " $(echo $NAMES) " in *" ${name} "*) ;; *) fail "${name} is not in api_secret_names of ${TFVARS}." ;; esac
  done
  NAMES="$OVERWRITE_NAMES"
  TARGET_ONLY=true
fi

command -v aws >/dev/null 2>&1 || fail "The AWS CLI is not installed."
command -v node >/dev/null 2>&1 || fail "Node.js is not installed."

is_set() {
  aws ssm get-parameter --region "$REGION" --name "${PREFIX}/$1" --query Parameter.Name --output text >/dev/null 2>&1
}

contains() {
  case "$1" in *" $2 "*) return 0 ;; *) return 1 ;; esac
}

PRIVATE_TMP_DIR=""
cleanup() {
  if [ -n "$PRIVATE_TMP_DIR" ]; then rm -rf "$PRIVATE_TMP_DIR"; fi
}
trap cleanup EXIT

# Writes one SecureString. The value goes from the environment of node to a
# file in a folder that only this user can open, and the file is deleted
# after the call. The AWS CLI cannot read --cli-input-json from a pipe.
put_secret() {
  local name="$1" value="$2"
  local bytes input status=0
  bytes="$(printf %s "$value" | wc -c | tr -d ' ')"
  if [ "$bytes" -gt "$MAX_VALUE_BYTES" ]; then
    echo "  ${name}: ${bytes} bytes is more than the ${MAX_VALUE_BYTES}-byte SSM limit. Not saved." >&2
    return 1
  fi
  if [ -z "$PRIVATE_TMP_DIR" ]; then
    PRIVATE_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/doxa-api-secrets.XXXXXX")"
    chmod 700 "$PRIVATE_TMP_DIR"
  fi
  input="${PRIVATE_TMP_DIR}/put-parameter.json"
  (
    umask 077
    SSM_NAME="${PREFIX}/${name}" SSM_VALUE="$value" node -e '
      process.stdout.write(JSON.stringify({
        Name: process.env.SSM_NAME,
        Value: process.env.SSM_VALUE,
        Type: "SecureString",
        Overwrite: true,
      }));
    ' > "$input"
  )
  aws ssm put-parameter --region "$REGION" --cli-input-json "file://${input}" --query Version --output text >/dev/null || status=$?
  rm -f "$input"
  return "$status"
}

generate_secret() {
  node -e '
    const { randomBytes } = require("node:crypto");
    process.stdout.write(randomBytes(64).toString("base64url").slice(0, Number(process.argv[1])));
  ' "$GENERATED_LENGTH"
}

read_private_key() {
  local name="$1" path
  read -r -p "  ${name}: path to the key file (.pem): " path
  path="${path/#\~/$HOME}"
  if [ ! -f "$path" ]; then
    echo "  ${name}: no file at ${path}. Skipped." >&2
    return 1
  fi
  if ! head -n 1 "$path" | grep -q -- '-----BEGIN .*PRIVATE KEY-----'; then
    echo "  ${name}: ${path} is not a PEM private key. Skipped." >&2
    return 1
  fi
  KEY_VALUE="$(cat "$path")"
}

echo "SSM path: ${PREFIX}/ (${REGION})"
echo "Names from: ${TFVARS#"${ROOT_DIR}/"}"

if [ "$LIST_ONLY" = true ]; then
  missing=0
  for name in $NAMES; do
    if is_set "$name"; then echo "  set      ${name}"; else echo "  missing  ${name}"; missing=$((missing + 1)); fi
  done
  [ "$missing" -eq 0 ] || { echo "${missing} missing."; exit 1; }
  echo "All set."
  exit 0
fi

identity="$(aws sts get-caller-identity --query '[Account,Arn]' --output text)" || fail "AWS credentials do not work. Sign in first."
echo "AWS account: ${identity}"
if [ "$ASSUME_YES" != true ]; then
  read -r -p "Write secrets to this account? [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Stopped. Nothing changed."; exit 0; }
fi

missing=""
generated=""
saved=0
for name in $NAMES; do
  if [ "$TARGET_ONLY" != true ] && is_set "$name"; then
    echo "  ${name}: set, skipped."
    continue
  fi

  value=""
  if contains "$GENERATED_NAMES" "$name"; then
    value="$(generate_secret)"
    generated="${generated} ${name}"
  elif [[ "$name" == *_PRIVATE_KEY ]]; then
    KEY_VALUE=""
    read_private_key "$name" && value="$KEY_VALUE"
    KEY_VALUE=""
  else
    read -r -s -p "  ${name} (hidden): " value
    echo
  fi

  if [ -z "$value" ]; then
    echo "  ${name}: empty, skipped."
    missing="${missing} ${name}"
    continue
  fi
  if put_secret "$name" "$value"; then
    echo "  ${name}: saved."
    saved=$((saved + 1))
  else
    missing="${missing} ${name}"
  fi
  value=""
done

echo
if [ -n "$generated" ]; then
  echo "New shared keys:${generated}"
  echo "The edge Worker must have the same values. Copy each one without printing it:"
  for name in $generated; do
    echo "  aws ssm get-parameter --region ${REGION} --name ${PREFIX}/${name} --with-decryption --query Parameter.Value --output text \\"
    echo "    | pnpm --filter @doxahq/api-edge exec wrangler secret put ${name} --env ${ENVIRONMENT}"
  done
  echo
fi
if [ "$saved" -gt 0 ]; then
  echo "Saved ${saved}. Running tasks keep their old values: deploy the origin again to load the new ones."
fi

if [ "$TARGET_ONLY" = true ]; then
  [ -z "$missing" ] || { echo "Not saved:${missing}"; exit 1; }
  exit 0
fi
if [ -n "$missing" ]; then
  echo "Still missing:${missing}"
  echo "The ECS task cannot start until every secret is set. Run this script again to add them."
  exit 1
fi
echo "All secrets are set."
