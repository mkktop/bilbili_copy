#!/usr/bin/env bash
set -euo pipefail

target="${1:?Usage: scripts/package-cli.sh TARGET [OUTPUT_DIRECTORY]}"
output="${2:-artifacts}"
case "$target" in
  aarch64-unknown-linux-musl) platform="linux-arm64" ;;
  x86_64-unknown-linux-musl) platform="linux-x86_64" ;;
  *) echo "Unsupported CLI release target: $target" >&2; exit 2 ;;
esac
binary="target/$target/release/weiyu-cli"
test -f "$binary"
mkdir -p "$output"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
install -m 0755 "$binary" "$staging/weiyu-cli"
install -m 0644 docs/server-cli.md "$staging/README.md"
install -m 0644 LICENSE "$staging/LICENSE"
install -m 0644 deploy/server/weiyu-cli.service "$staging/weiyu-cli.service"
install -m 0644 deploy/server/weiyu.env.example "$staging/weiyu.env.example"
archive="weiyu-cli-$platform.tar.gz"
tar -czf "$output/$archive" -C "$staging" .
(cd "$output" && sha256sum "$archive" > "$archive.sha256")
