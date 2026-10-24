#!/usr/bin/env bash
# Builds the spec-reader image and fails when it holds any file in /app/job
# other than the two bundles, or a package manager.
set -euo pipefail

image="doxa-spec-reader-image-check"
repository_root="$(cd "$(dirname "$0")/../../../.." && pwd)"

docker build -t "$image" -f "$repository_root/apps/utility-jobs/spec-reader/Dockerfile" "$repository_root"

files="$(docker run --rm --entrypoint sh "$image" -c 'cd /app/job && find . -mindepth 1 | sort')"
expected="$(printf './job.mjs\n./supervisor.mjs')"
if [[ "$files" != "$expected" ]]; then
  echo "The job folder holds unexpected files:" >&2
  echo "$files" >&2
  exit 1
fi

docker run --rm --entrypoint sh "$image" -c '
  for tool in npm npx corepack yarn; do
    if command -v "$tool" >/dev/null; then echo "The image still has $tool." >&2; exit 1; fi
  done
  test "$(id -un)" = node
  test ! -w /app/job/job.mjs
'
echo "The spec-reader image holds only its job."
