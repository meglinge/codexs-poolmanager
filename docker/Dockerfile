# poolmanager image: serves both roles (`serve` and `runner`).
# The runner role needs the codexs binaries, which are downloaded from the
# meglinge/codex releases at build time (CODEXS_VERSION = official Codex version,
# CODEXS_RELEASE = release tag suffix, e.g. 0.153.4-2 for a rebuild of 0.153.4).

# Admin UI (React/Vite, see web/README.md) is embedded into the binary.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM rust:1.94-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
COPY --from=web /web/dist ./web/dist
RUN cargo build --release --locked && strip target/release/poolmanager

FROM debian:bookworm-slim AS runtime
ARG CODEXS_VERSION=0.153.4
ARG CODEXS_RELEASE=0.153.4-2
ARG CODEXS_REPO=meglinge/codex
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*
# codexs + helpers next to it (codex-code-mode-host, bwrap)
RUN set -eux; \
    curl -fsSL "https://github.com/${CODEXS_REPO}/releases/download/codexs-v${CODEXS_RELEASE}/codexs-${CODEXS_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
      -o /tmp/codexs.tar.gz; \
    mkdir -p /opt/codexs; \
    tar -xzf /tmp/codexs.tar.gz -C /opt/codexs --strip-components=1; \
    rm /tmp/codexs.tar.gz; \
    chmod +x /opt/codexs/codexs /opt/codexs/codex-code-mode-host /opt/codexs/bwrap; \
    /opt/codexs/codexs --version
COPY --from=builder /src/target/release/poolmanager /usr/local/bin/poolmanager
RUN useradd -r -u 10001 -m -d /home/pm pm && mkdir -p /data/runner && chown -R pm:pm /data
USER pm
ENV PM_CODEXS_BIN=/opt/codexs/codexs \
    PM_RUNNER_DATA_DIR=/data/runner \
    PM_LISTEN=0.0.0.0:8800 \
    PM_RUNNER_LISTEN=0.0.0.0:7000
EXPOSE 8800 7000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/poolmanager"]
CMD ["serve"]
