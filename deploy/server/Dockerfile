# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS builder
ARG TARGETARCH
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=secret,id=proxy_ca \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target,id=weiyu-cli-${TARGETARCH} \
    if [ -f /run/secrets/proxy_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/proxy_ca; fi; \
    cargo build --locked --release -p weiyu-cli && install -m 0755 target/release/weiyu-cli /weiyu-cli

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
LABEL org.opencontainers.image.source="https://github.com/mkktop/bilbili_copy"
COPY --from=builder /weiyu-cli /usr/local/bin/weiyu-cli
EXPOSE 8787
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/weiyu-cli"]
CMD ["serve", "--listen", "0.0.0.0:8787"]
