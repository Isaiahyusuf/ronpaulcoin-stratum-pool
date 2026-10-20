#!/usr/bin/env bash
# Differential check: compiles the daemon's own scrypt.c and compares it with lib/scryptHash.js on random headers.
# Usage: DAEMON_SRC=/path/to/ronpaulcoincore/src tools/compare-daemon-scrypt.sh
set -euo pipefail

: "${DAEMON_SRC:?set DAEMON_SRC to the daemon src directory containing scrypt.c}"
OPENSSL_PREFIX="${OPENSSL_PREFIX:-$(brew --prefix openssl@3 2>/dev/null || echo /usr)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cc -w -O2 -I"$DAEMON_SRC" -I"$OPENSSL_PREFIX/include" "$ROOT/tools/daemon-scrypt-harness.c" \
    "$DAEMON_SRC/scrypt.c" -L"$OPENSSL_PREFIX/lib" -lcrypto -o "$WORK/harness"

WORK="$WORK" ROOT="$ROOT" node -e '
const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { scryptHash } = require(process.env.ROOT + "/lib/scryptHash");
const headers = [Buffer.alloc(80), Buffer.alloc(80, 0xff), ...Array.from({ length: 200 }, () => randomBytes(80))];
const expected = execFileSync(process.env.WORK + "/harness", { input: headers.map((h) => h.toString("hex")).join("\n") + "\n" })
    .toString().trim().split("\n");
const mismatches = headers.filter((h, i) => scryptHash(h).toString("hex") !== expected[i]).length;
console.log(`${headers.length} headers compared, ${mismatches} mismatches`);
process.exit(mismatches ? 1 : 0);
'
