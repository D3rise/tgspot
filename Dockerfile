FROM rust:1.90.0-bookworm AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt clippy
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo fmt --all --check \
    && cargo clippy --all-targets --locked -- -D warnings \
    && cargo test --all-targets --locked \
    && cargo build --release --locked \
    && install -Dm755 target/release/tgspot /out/tgspot

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home tgspot \
    && mkdir -p /app
WORKDIR /app
COPY --from=build /out/tgspot /usr/local/bin/tgspot
USER tgspot
ENV RUST_LOG=tgspot=info,librespot=warn
CMD ["tgspot"]
