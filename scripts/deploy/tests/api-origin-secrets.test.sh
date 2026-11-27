#!/usr/bin/env bash
# Tests of scripts/deploy/api-origin-secrets.sh against a fake AWS CLI that keeps
# parameters in a temporary folder. Nothing reaches AWS.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/deploy/api-origin-secrets.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/doxa-api-secrets-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="${TMP_DIR}/bin"
export FAKE_SSM_STORE="${TMP_DIR}/ssm"
export FAKE_AWS_ARGS_LOG="${TMP_DIR}/aws-args.log"
mkdir -p "$FAKE_BIN" "$FAKE_SSM_STORE"

cat > "${FAKE_BIN}/aws" <<'FAKE'
#!/usr/bin/env bash
# A fake AWS CLI: sts get-caller-identity, ssm get-parameter and ssm put-parameter.
printf '%s\n' "$*" >> "$FAKE_AWS_ARGS_LOG"
name_of() { while [ $# -gt 0 ]; do [ "$1" = "--name" ] && { echo "$2"; return; }; shift; done; }
input_of() { while [ $# -gt 0 ]; do [ "$1" = "--cli-input-json" ] && { echo "${2#file://}"; return; }; shift; done; }
file_of() { echo "${FAKE_SSM_STORE}/$(echo "$1" | tr '/' '_')"; }
case "$1 $2" in
  "sts get-caller-identity") printf '123456789012\tarn:aws:iam::123456789012:user/test\n' ;;
  "ssm get-parameter") file="$(file_of "$(name_of "$@")")"; [ -f "$file" ] || exit 254; name_of "$@" ;;
  "ssm put-parameter")
    input_file="$(input_of "$@")"
    [ "$(stat -f %Lp "$input_file" 2>/dev/null || stat -c %a "$input_file")" = "600" ] || exit 4
    [ "$(stat -f %Lp "$(dirname "$input_file")" 2>/dev/null || stat -c %a "$(dirname "$input_file")")" = "700" ] || exit 5
    echo "$input_file" >> "${FAKE_AWS_ARGS_LOG}.inputs"
    input="$(cat "$input_file")"
    name="$(printf %s "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).Name))')"
    printf %s "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);if(p.Type!=="SecureString"||p.Overwrite!==true)process.exit(3);process.stdout.write(p.Value)})' > "$(file_of "$name")"
    echo 1 ;;
  *) echo "fake aws: unexpected $*" >&2; exit 9 ;;
esac
FAKE
chmod +x "${FAKE_BIN}/aws"
export PATH="${FAKE_BIN}:${PATH}"

TFVARS="${TMP_DIR}/terraform.tfvars"
cat > "$TFVARS" <<'TFVARS'
cpu_units = 2048
api_secret_names = [
  "DATABASE_URL",
  # A comment with "NOT_A_SECRET" in it.
  "GITHUB_APP_PRIVATE_KEY",
  "ORIGIN_SHARED_SECRET", "BRIDGE_SHARED_SECRET",
]
other_list = ["IGNORED"]
TFVARS

PEM="${TMP_DIR}/app.pem"
printf -- '-----BEGIN RSA PRIVATE KEY-----\nMIIEtest\n-----END RSA PRIVATE KEY-----\n' > "$PEM"
NOT_PEM="${TMP_DIR}/notes.txt"
echo "hello" > "$NOT_PEM"

stored() { cat "${FAKE_SSM_STORE}/_doxa_api_test_$1"; }
is_stored() { [ -f "${FAKE_SSM_STORE}/_doxa_api_test_$1" ]; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$SCRIPT" --environment test --tfvars "$TFVARS" "$@"; }

# The secret names come from api_secret_names only.
output="$(run --list 2>&1)" && fail "--list must exit 1 while secrets are missing"
for name in DATABASE_URL GITHUB_APP_PRIVATE_KEY ORIGIN_SHARED_SECRET BRIDGE_SHARED_SECRET; do
  grep -q "missing  ${name}" <<<"$output" || fail "--list must show ${name} as missing"
done
grep -q "NOT_A_SECRET\|IGNORED" <<<"$output" && fail "--list must read only api_secret_names, without comments"

# Without --yes, any answer but y stops before writing.
printf 'n\n' | run >/dev/null
[ -z "$(ls "$FAKE_SSM_STORE")" ] || fail "an answer other than y must change nothing"

# A typed value, a key file and two generated keys. Nothing is printed or passed as an argument.
DB_URL="postgresql://user:hunter2-very-secret@db.example/doxa"
output="$(printf '%s\n%s\n' "$DB_URL" "$PEM" | run --yes 2>&1)"
[ "$(stored DATABASE_URL)" = "$DB_URL" ] || fail "DATABASE_URL must be saved as typed"
[ "$(stored GITHUB_APP_PRIVATE_KEY)" = "$(cat "$PEM")" ] || fail "the private key must be saved from the file"
for name in ORIGIN_SHARED_SECRET BRIDGE_SHARED_SECRET; do
  [ "$(stored "$name" | wc -c | tr -d ' ')" -eq 48 ] || fail "${name} must be a generated 48-character key"
  [[ "$(stored "$name")" =~ ^[A-Za-z0-9_-]+$ ]] || fail "${name} must be URL-safe"
done
[ "$(stored ORIGIN_SHARED_SECRET)" != "$(stored BRIDGE_SHARED_SECRET)" ] || fail "the two keys must differ"
grep -q "hunter2\|MIIEtest" <<<"$output" && fail "the output must not show any value"
grep -q "hunter2\|MIIEtest" "$FAKE_AWS_ARGS_LOG" && fail "no value may appear in the arguments of the AWS CLI"
while read -r input_file; do
  [ ! -e "$input_file" ] || fail "the temporary file with a value must be deleted after the call"
done < "${FAKE_AWS_ARGS_LOG}.inputs"
grep -q "wrangler secret put ORIGIN_SHARED_SECRET --env test" <<<"$output" || fail "the output must say how to copy new keys to the edge Worker"
grep -q "All secrets are set." <<<"$output" || fail "a complete run must say that all secrets are set"
run --list >/dev/null || fail "--list must exit 0 when every secret is set"

# A second run skips what is set and keeps the values.
origin_key="$(stored ORIGIN_SHARED_SECRET)"
output="$(run --yes </dev/null 2>&1)"
grep -q "DATABASE_URL: set, skipped." <<<"$output" || fail "a set secret must be skipped"
[ "$(stored ORIGIN_SHARED_SECRET)" = "$origin_key" ] || fail "a set key must not be generated again"

# --overwrite asks again for that name only, and rotates a generated key.
printf 'postgresql://new\n' | run --yes --overwrite DATABASE_URL --overwrite ORIGIN_SHARED_SECRET >/dev/null
[ "$(stored DATABASE_URL)" = "postgresql://new" ] || fail "--overwrite must replace the value"
[ "$(stored ORIGIN_SHARED_SECRET)" != "$origin_key" ] || fail "--overwrite must generate a new key"

# An empty answer and a file that is not a PEM key are skipped, and the run fails.
rm "${FAKE_SSM_STORE}"/*
output="$(printf '\n%s\n' "$NOT_PEM" | run --yes 2>&1)" && fail "a run with missing secrets must exit 1"
grep -q "Still missing: DATABASE_URL GITHUB_APP_PRIVATE_KEY" <<<"$output" || fail "the run must list what is still missing"
is_stored DATABASE_URL && fail "an empty value must not be saved"
is_stored GITHUB_APP_PRIVATE_KEY && fail "a file that is not a PEM key must not be saved"

# Values over the SSM standard limit are refused.
rm "${FAKE_SSM_STORE}"/*
big="$(head -c 5000 /dev/zero | tr '\0' 'a')"
output="$(printf '%s\n%s\n' "$big" "$PEM" | run --yes 2>&1)" && fail "a value over 4 KB must fail the run"
grep -q "more than the 4096-byte SSM limit" <<<"$output" || fail "the run must name the size limit"
is_stored DATABASE_URL && fail "a value over 4 KB must not be saved"

# Bad input.
run --environment "Bad Name" --list >/dev/null 2>&1 && fail "a bad environment name must be refused"
bash "$SCRIPT" --tfvars "${TMP_DIR}/none.tfvars" --list >/dev/null 2>&1 && fail "a missing variables file must be refused"

echo "api-origin-secrets tests passed"
