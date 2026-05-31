#!/usr/bin/env bash
# Build the server-registry Solana program.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# cargo-build-sbf ships with platform-tools Rust 1.75, which cannot parse crate
# manifests that use `edition = "2024"` (stabilised in Cargo 1.85).  Several
# transitive dependencies (toml_datetime 1.1.1, wit-bindgen 0.57.x, etc.) that
# arrive via solana-program's dependency graph trigger this error.
#
# WORKAROUND (two steps):
#  1. Generate Cargo.lock with Rust 1.79 (understands the dep graph but doesn't
#     write v4 lock-file format that the BPF toolchain can't read).
#  2. Vendor the resolved crates using system Rust; patch the one crate whose
#     Cargo.toml uses edition=2024 but is never compiled for BPF (wit-bindgen -
#     it is only used for wasm32 targets via the jobserver->getrandom chain).
#     Then build --offline so the 1.75 toolchain never hits the registry.
#
# Constraints committed to in Cargo.toml:
#   solana-program = "=1.17.34"   (1.18.x unconditionally pulls borsh 1.x ->
#                                  proc-macro-crate 3.x -> toml_edit -> toml_datetime 1.1)
#   blake3 = ">=1.3, <1.6"       (1.6+ pulls digest 0.11.x -> block-buffer 0.12 (ed2024))

set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROGRAM_DIR="$(cd "$(dirname "$0")" && pwd)"
CARGO_MANIFEST="$PROGRAM_DIR/Cargo.toml"
VENDOR_DIR="$REPO_ROOT/target/sbf-vendor"
CARGO_CONFIG="$REPO_ROOT/.cargo/config.toml"

echo "==> Generating Cargo.lock with Rust 1.79 (produces v3 format)..."
rustup run 1.79.0 cargo generate-lockfile \
  --manifest-path "$REPO_ROOT/Cargo.toml"

echo "==> Vendoring dependencies with system Rust..."
mkdir -p "$VENDOR_DIR"
cargo vendor "$VENDOR_DIR" --manifest-path "$REPO_ROOT/Cargo.toml" > /dev/null

echo "==> Patching wit-bindgen edition (wasm32-only crate, never compiled for BPF)..."
sed -i 's/edition = "2024"/edition = "2021"/' "$VENDOR_DIR/wit-bindgen/Cargo.toml"

echo "==> Writing temporary .cargo/config.toml..."
mkdir -p "$REPO_ROOT/.cargo"
cat > "$CARGO_CONFIG" << EOF
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "$VENDOR_DIR"
EOF

cleanup() {
  rm -f "$CARGO_CONFIG"
  rmdir "$REPO_ROOT/.cargo" 2>/dev/null || true
  echo "==> Cleaned up .cargo/config.toml"
}
trap cleanup EXIT

echo "==> Building SBF program..."
cargo build-sbf --manifest-path "$CARGO_MANIFEST"

echo "==> Done - artifact: $REPO_ROOT/target/deploy/server_registry.so"
