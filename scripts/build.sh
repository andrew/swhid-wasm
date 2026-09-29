#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w' -o build/resolver.next.wasm ./cmd/resolver
mv build/resolver.next.wasm build/resolver.wasm
GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w' -o build/analyzer-go.next.wasm ./cmd/wasm
mv build/analyzer-go.next.wasm build/analyzer-go.wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" build/go-wasm_exec.js
go_root="$(go env GOROOT)"
if [[ -f "$go_root/LICENSE" ]]; then
  cp "$go_root/LICENSE" build/GO-LICENSE
else
  cp "$go_root/../LICENSE" build/GO-LICENSE
fi
go build -trimpath -o build/native ./cmd/native
go build -trimpath -o build/server ./cmd/server
