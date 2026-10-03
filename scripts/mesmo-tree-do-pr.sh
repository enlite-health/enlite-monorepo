#!/usr/bin/env bash
# Spec 038 F4: o merge commit em `main` tem o MESMO conteúdo da cabeça do PR que o
# `pr-gate` já testou? Compara os trees de `HEAD` (merge commit) e `HEAD^2` (cabeça do PR).
#
# FAIL-CLOSED: `igual=true` só quando os dois trees RESOLVEM, são não vazios e iguais.
# Sem 2º pai (commit normal, clone raso), tree diferente ou qualquer erro => `igual=false`,
# e quem consome roda a suíte normalmente. Nunca sai com erro: o resultado é sempre o valor.
set -u

OUT="${GITHUB_OUTPUT:-/dev/stdout}"

tree_merge=$(git rev-parse --verify -q 'HEAD^{tree}' 2>/dev/null) || tree_merge=""
tree_pr=$(git rev-parse --verify -q 'HEAD^2^{tree}' 2>/dev/null) || tree_pr=""

echo "tree do merge  (HEAD^{tree})   : ${tree_merge:-<não resolveu>}" >&2
echo "tree do PR     (HEAD^2^{tree}) : ${tree_pr:-<não resolveu>}" >&2

if [ -n "$tree_merge" ] && [ -n "$tree_pr" ] && [ "$tree_merge" = "$tree_pr" ]; then
  igual=true
else
  igual=false
fi

echo "igual=$igual" >&2
echo "igual=$igual" >> "$OUT"
exit 0
