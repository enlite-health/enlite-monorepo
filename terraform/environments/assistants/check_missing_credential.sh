#!/usr/bin/env bash
# Items 5 and 29b (plan 080 §4.5): no forbidden credential/role in the stack's HCL or in the service's workflows.
# Usage: check_missing_credential.sh <dir-or-file>...
# Scans *.tf, *.yml, *.yaml. In a directory it skips testdata/ and .terraform/. Comments count TOO.
# rc 0 = clean (N>0) | rc 1 = forbidden found | rc 2 = N=0 or wrong usage.
set -u
LC_ALL=C
[ "$#" -ge 1 ] || { echo "usage: $0 <path>..." >&2; exit 2; }

PROIBIDOS='enlite-ar-db|mcp-token-|enlite-api-key|mcp-principal-|worker-data-key|gbrain-db|twilio|waba|periskope|objectAdmin|objectCreator|storage\.admin|objectUser|legacyBucketWriter'

arquivos=()
for c in "$@"; do
  if [ -d "$c" ]; then
    while IFS= read -r f; do arquivos+=("$f"); done < <(
      find "$c" \( -name testdata -o -name .terraform \) -prune -o -type f \
        \( -name '*.tf' -o -name '*.yml' -o -name '*.yaml' \) -print | sort)
  elif [ -f "$c" ]; then
    arquivos+=("$c")
  else
    echo "WARNING: path does not exist, ignored: $c" >&2
  fi
done

n=${#arquivos[@]}
if [ "$n" -eq 0 ]; then
  echo "ERROR: 0 files scanned (N = 0)" >&2
  exit 2
fi

achados=$(grep -HniE "$PROIBIDOS" "${arquivos[@]}" || true)
if [ -n "$achados" ]; then
  total=$(printf '%s\n' "$achados" | wc -l | tr -d ' ')
  printf '%s\n' "$achados"
  echo "forbidden: $total in $n files"
  exit 1
fi
echo "forbidden: 0 in $n files"
