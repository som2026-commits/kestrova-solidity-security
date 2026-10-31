#!/usr/bin/env sh
# Free Kestrova preview of one Solidity file: severity counts and High/Medium detector names. No key, no payment.
# usage: ./preview.sh path/to/Contract.sol
set -eu
f="${1:?usage: preview.sh Contract.sol}"
python3 -c 'import json,sys; print(json.dumps({"sources": {sys.argv[1]: open(sys.argv[1], encoding="utf-8").read()}}))' "$f" |
  curl -sS -X POST "${KESTROVA_URL:-https://kestrova.onrender.com}/preview?src=example" -H 'content-type: application/json' --data-binary @-
echo
