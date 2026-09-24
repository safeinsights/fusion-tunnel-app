#!/usr/bin/env bash
# The relay wire contract is one file owned by fusion-relay; this repo carries a verbatim copy.
# With a relay checkout next to this one, fail if the two differ.
set -euo pipefail
cd "$(dirname "$0")/.."
canonical=../fusion-relay/src/protocol.ts
if [[ ! -f $canonical ]]; then echo "check-protocol: no ../fusion-relay checkout; skipped"; exit 0; fi
if diff -q "$canonical" src/relay-protocol.ts >/dev/null; then echo "check-protocol: src/relay-protocol.ts matches fusion-relay/src/protocol.ts"
else echo "check-protocol: src/relay-protocol.ts differs from fusion-relay/src/protocol.ts:"; diff "$canonical" src/relay-protocol.ts || true; exit 1; fi
