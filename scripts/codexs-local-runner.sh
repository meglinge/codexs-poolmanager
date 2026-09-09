#!/usr/bin/env bash
# Build codexs from a local Codex fork checkout, layer it over the current
# runner image and roll the runner with abctl — no GitHub release needed.
#
#   scripts/codexs-local-runner.sh [ref]     ref: git ref to fetch+checkout first
#                                            (e.g. origin/codexs, a sha, a tag); default: as checked out
# Environment:
#   CODEX_SRC        Codex fork checkout          (default: ~/src/codex)
#   BASE_IMAGE       runner image to layer over   (default: runner image from deploy/state/images.json, else slot a)
#   BUILD_IN_DOCKER  1 (default): build inside docker/Dockerfile.codexs-builder (Debian bookworm, same
#                    glibc as the runner image); 0: cargo on the host (only if the host glibc is not
#                    newer than the runner image's)
#   RUST_IMAGE       builder base                 (default: rust:1.95.0-bookworm — keep in step with rust-toolchain.toml)
#   NO_ROLL=1        only build the image, do not roll the runner
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_SRC="${CODEX_SRC:-$HOME/src/codex}"
BUILD_IN_DOCKER="${BUILD_IN_DOCKER:-1}"
RUST_IMAGE="${RUST_IMAGE:-rust:1.95.0-bookworm}"
ref="${1:-}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$CODEX_SRC/codex-rs/codexs" ]] || die "$CODEX_SRC is not a Codex fork checkout with codex-rs/codexs (git clone -b codexs https://github.com/meglinge/codex $CODEX_SRC)"
command -v docker >/dev/null || die "docker is required"

cd "$CODEX_SRC"
if [[ -n "$ref" ]]; then
  remote_ref="${ref#origin/}"
  log "Fetching $remote_ref"
  git fetch --depth 1 origin "$remote_ref"
  git checkout -q FETCH_HEAD
fi
sha="$(git rev-parse --short=7 HEAD)"
log "Building codexs from $(git log --oneline -1)"

if [[ "$BUILD_IN_DOCKER" == "1" ]]; then
  builder="codexs-builder:${RUST_IMAGE##*:}"
  log "Builder image $builder (from $RUST_IMAGE)"
  docker build -q -f "$here/docker/Dockerfile.codexs-builder" --build-arg "RUST_IMAGE=$RUST_IMAGE" -t "$builder" "$here/docker" >/dev/null
  # Separate target dir: host builds and container builds must not share artifacts.
  # Cargo/rustup caches live in named volumes so incremental builds stay fast.
  docker run --rm \
    -v "$CODEX_SRC":/src \
    -v codexs-builder-cargo:/usr/local/cargo \
    -v codexs-builder-rustup:/usr/local/rustup \
    -e CARGO_TARGET_DIR=/src/codex-rs/target-bookworm \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    -w /src/codex-rs "$builder" cargo build -p codexs --release
  release_dir="$CODEX_SRC/codex-rs/target-bookworm/release"
else
  export PATH="$HOME/.cargo/bin:$PATH"
  command -v cargo >/dev/null || die "cargo is required (rustup)"
  (cd codex-rs && cargo build -p codexs --release)
  release_dir="$CODEX_SRC/codex-rs/target/release"
fi
bin="$release_dir/codexs"
[[ -x "$bin" ]] || die "build produced no $bin"

if [[ -z "${BASE_IMAGE:-}" ]]; then
  BASE_IMAGE="$(python3 - "$here/deploy/state/images.json" <<'EOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
img = d.get("runner") or d.get("a") or ""
# a previous local build: peel back to the published base it was built on
if img.startswith("codexs-poolmanager-runner:"):
    base = img.split(":", 1)[1].split("-codexs-", 1)[0]
    img = "ghcr.io/meglinge/codexs-poolmanager:sha-" + base
print(img)
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
  [[ -x "$release_dir/$helper" ]] && cp "$release_dir/$helper" "$stage/helpers/"
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
