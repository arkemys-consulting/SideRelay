# syntax=docker/dockerfile:1
FROM rust:1.95-slim-bookworm AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates cmake curl git libssl-dev pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
        amd64) platform=x86_64-unknown-linux-gnu; checksum=1c9cf0e1e3ffae6c8b58d29281d949dab560cea613b80d361f323f93071df7c8 ;; \
        arm64) platform=aarch64-unknown-linux-gnu; checksum=8aa36d841d69fb62fa00a3e0d8670a52dc16a9a94c2c6f96c545d889c49f18aa ;; \
        *) echo "Unsupported build architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/leptos-rs/cargo-leptos/releases/download/v0.3.11/cargo-leptos-$platform.tar.gz" -o /tmp/cargo-leptos.tar.gz; \
    printf '%s  %s\n' "$checksum" /tmp/cargo-leptos.tar.gz | sha256sum -c; \
    tar -xzf /tmp/cargo-leptos.tar.gz -C /usr/local/cargo/bin --strip-components=1 "cargo-leptos-$platform/cargo-leptos"; \
    rm /tmp/cargo-leptos.tar.gz; \
    rustup target add wasm32-unknown-unknown

WORKDIR /build
COPY moteur/construire.sh moteur/*.patch ./moteur/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build-target \
    CARGO_TARGET_DIR=/build-target CARGO_NET_GIT_FETCH_WITH_CLI=true \
    SIDERELAY_BUILD_PORTAL=1 bash moteur/construire.sh

FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="SideRelay" \
      org.opencontainers.image.source="https://github.com/arkemys-consulting/SideRelay"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libssl3 libplist-utils openssl python3 python3-cryptography python3-pil python3-zeroconf qrencode \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 700 -o 10001 -g 10001 /var/lib/siderelay /var/lib/siderelay-secrets

WORKDIR /opt/siderelay
COPY signature-ios ./signature-ios
COPY Interface/*.py Interface/*.js Interface/*.css Interface/Store*.json ./Interface/
COPY Interface/Info.plist ./Interface/Info.plist
COPY docs/screenshots/siderelay-icon.png ./Interface/SideRelay.png
COPY LICENSE docs/licenses/isideload-MIT.txt ./notices/
COPY --from=build /build/moteur/target/JAS-README.md ./notices/
COPY --from=build /build/moteur/jas ./moteur/jas
COPY --from=build /build/moteur/target/site ./moteur/target/site

ENV SIDERELAY_DATA_DIR=/var/lib/siderelay \
    SIDERELAY_IPA_INBOX_DIR=/var/lib/siderelay/IPA-Inbox
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s \
    CMD curl -fsS -o /dev/null "http://127.0.0.1:${SIDERELAY_WEB_PORT:-8080}/_siderelay/health"
ENTRYPOINT ["python3", "-B", "-m", "Interface.PortailDocker"]
