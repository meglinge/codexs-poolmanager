#!/usr/bin/env bash
# Build codexs from a local Codex fork checkout, layer it over the current
# runner image and roll the runner with abctl — no GitHub release needed.
#
#   scripts/codexs-local-runner.sh [ref]     ref: git ref to fetch+checkout first
#                                            (e.g. origin/codexs, a sha, a tag); default: as checked out
# Environment:
#   CODEX_SRC   Codex fork checkout          (default: ~/src/codex)
#   BASE_IMAGE  runner image to layer over   (default: runner image from deploy/state/images.json, else slot a)
#   NO_ROLL=1   only build the image, do not roll the runner
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_SRC="${CODEX_SRC:-$HOME/src/codex}"
ref="${1:-}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$CODEX_SRC/codex-rs/codexs" ]] || die "$CODEX_SRC is not a Codex fork checkout with codex-rs/codexs (git clone -b codexs https://github.com/meglinge/codex $CODEX_SRC)"
command -v docker >/dev/null || die "docker is required"
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || die "cargo is required (rustup)"

cd "$CODEX_SRC"
if [[ -n "$ref" ]]; then
  remote_ref="${ref#origin/}"
  log "Fetching $remote_ref"
  git fetch --depth 1 origin "$remote_ref"
  git checkout -q FETCH_HEAD
fi
sha="$(git rev-parse --short=7 HEAD)"
log "Building codexs from $(git log --oneline -1)"
(cd codex-rs && cargo build -p codexs --release)
bin="$CODEX_SRC/codex-rs/target/release/codexs"
[[ -x "$bin" ]] || die "build produced no $bin"

if [[ -z "${BASE_IMAGE:-}" ]]; then
  BASE_IMAGE="$(python3 - "$here/deploy/state/images.json" <<'EOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
print(d.get("runner") or d.get("a") or "")
EOF
)"
fi
[[ -n "$BASE_IMAGE" ]] || die "no BASE_IMAGE and deploy/state/images.json has no runner/slot image yet (run abctl deploy first)"
base_tag="${BASE_IMAGE##*:}"
base_tag="${base_tag#sha-}"
tag="codexs-poolmanager-runner:${base_tag}-codexs-${sha}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$bin" "$stage/codexs"
mkdir -p "$stage/helpers"
for helper in codex-code-mode-host bwrap; do
  [[ -x "$CODEX_SRC/codex-rs/target/release/$helper" ]] && cp "$CODEX_SRC/codex-rs/target/release/$helper" "$stage/helpers/"
done
log "Building $tag over $BASE_IMAGE"
docker build -q -f "$here/docker/Dockerfile.runner-local" --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$tag" "$stage" >/dev/null
docker run --rm --entrypoint /opt/codexs/codexs "$tag" --version

if [[ "${NO_ROLL:-0}" == "1" ]]; then
  log "Built $tag (NO_ROLL=1, runner not rolled)"
  exit 0
fi
log "Rolling runner to $tag"
cd "$here"
python3 deploy/abctl.py runner "$tag"
