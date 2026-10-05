#!/usr/bin/env bash
# Spec 038 T6.1: teste de `scripts/mesmo-tree-do-pr.sh`.
#
# Esse script decide PULAR a suíte antes do deploy de PRD. Uma edição que o faça dizer sempre
# `igual=true` deployaria sem teste — este teste monta repos git sintéticos e prova os 5 casos,
# em particular os que DEVEM dar `false` (fail-closed). rc!=0 se qualquer caso falhar.
# Override para sabotagem local: MESMO_TREE_SCRIPT=/caminho/do/script.
set -u

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${MESMO_TREE_SCRIPT:-$AQUI/mesmo-tree-do-pr.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

gi() { git -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@"; }

# Origem: main -> merge de `prd` (PR atualizado, tree do merge == tree do PR),
# depois merge de `velho` (PR criado de HEAD~1, sem o que a base ganhou: trees diferem),
# depois um commit comum (sem 2º pai).
O="$TMP/origin"
mkdir "$O" && cd "$O" || exit 2
git init -q -b main
echo a > a && gi add a && gi commit -qm base
git checkout -q -b prd && echo b > b && gi add b && gi commit -qm feat
git checkout -q main && gi merge -q --no-ff prd -m "merge atualizado"
SHA_IGUAL=$(git rev-parse HEAD)
git checkout -q -b velho HEAD~1 && echo c > c && gi add c && gi commit -qm feat2
git checkout -q main && gi merge -q --no-ff velho -m "merge atrasado"
SHA_ATRASADO=$(git rev-parse HEAD)
echo d > d && gi add d && gi commit -qm "commit sem 2o pai"
SHA_SEM_PAI=$(git rev-parse HEAD)

FALHAS=0
# caso <nome> <sha> <depth> <esperado>: clona raso como o actions/checkout e roda o script.
caso() {
  local nome="$1" sha="$2" depth="$3" esperado="$4" dir="$TMP/c_$1" saida got
  mkdir "$dir" && cd "$dir" || exit 2
  git init -q && git remote add origin "file://$O"
  git fetch -q --no-tags --depth="$depth" origin "+$sha:refs/remotes/origin/main" 2>/dev/null
  git checkout -q --force -B main refs/remotes/origin/main
  saida="$dir/out"; : > "$saida"
  GITHUB_OUTPUT="$saida" bash "$SCRIPT" >/dev/null 2>&1
  got=$(sed -n 's/^igual=//p' "$saida" | tail -1)
  if [ "$got" = "$esperado" ]; then
    echo "[ok] $nome (depth=$depth): igual=$got"
  else
    echo "[FALHOU] $nome (depth=$depth): esperado igual=$esperado, obtido igual=${got:-<vazio>}"
    FALHAS=$((FALHAS + 1))
  fi
}

caso merge-com-pr-atualizado "$SHA_IGUAL"    2 true
caso pr-atrasado-na-base     "$SHA_ATRASADO" 2 false
caso commit-sem-segundo-pai  "$SHA_SEM_PAI"  2 false
caso clone-depth-1           "$SHA_IGUAL"    1 false
caso depth-2-pr-atualizado   "$SHA_IGUAL"    2 true

[ "$FALHAS" -eq 0 ] && echo "todos os casos passaram" || echo "$FALHAS caso(s) falharam"
[ "$FALHAS" -eq 0 ]
