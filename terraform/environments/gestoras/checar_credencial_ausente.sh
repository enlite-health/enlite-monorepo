#!/usr/bin/env bash
# Itens 5 e 29b (plano 080 §4.5): nenhuma credencial/papel proibido no HCL do stack nem nos workflows do servico.
# Uso: checar_credencial_ausente.sh <dir-ou-arquivo>...
# Varre *.tf, *.yml, *.yaml. Em diretorio ignora testdata/ e .terraform/. Comentario TAMBEM conta.
# rc 0 = limpo (N>0) | rc 1 = proibido achado | rc 2 = N=0 ou uso errado.
set -u
LC_ALL=C
[ "$#" -ge 1 ] || { echo "uso: $0 <caminho>..." >&2; exit 2; }

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
    echo "AVISO: caminho inexistente, ignorado: $c" >&2
  fi
done

n=${#arquivos[@]}
if [ "$n" -eq 0 ]; then
  echo "ERRO: 0 arquivos varridos (N = 0)" >&2
  exit 2
fi

achados=$(grep -HniE "$PROIBIDOS" "${arquivos[@]}" || true)
if [ -n "$achados" ]; then
  total=$(printf '%s\n' "$achados" | wc -l | tr -d ' ')
  printf '%s\n' "$achados"
  echo "proibidos: $total em $n arquivos"
  exit 1
fi
echo "proibidos: 0 em $n arquivos"
