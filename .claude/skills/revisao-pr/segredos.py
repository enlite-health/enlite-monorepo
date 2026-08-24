#!/usr/bin/env python3
"""
V10 do revisao-pr — segredo literal em linha adicionada.

⚠️ Este check já morreu DUAS vezes por armadilha de awk:
  1. `IGNORECASE` (extensão do gawk) — o awk do macOS ignora em silêncio e
     `apiKey` camelCase voltava a ser invisível;
  2. `{16,}` (intervalo POSIX) — o **mawk**, awk padrão de Debian/Ubuntu e
     portanto do CI, não honra: o check ficava MORTO em Linux imprimindo ✅.
     Medido pelo revisor em `node:20`: testar.sh 23/25.
Por isso saiu do awk. Python já é dependência do V2.

Lê um diff unificado no stdin/argv e imprime as linhas suspeitas.
"""
import re
import sys
import io

CHAVE = re.compile(r'(api[_-]?key|secret|passwd|password|token|credential)', re.I)
MESMA = re.compile(
    r'(api[_-]?key|secret|passwd|password|token|credential)'
    r'["\'\s]*[:=]["\'\s]*'
    r'([A-Za-z0-9_./+-]{16,})', re.I)
VALOR = re.compile(r'[:=]\s*["\']([A-Za-z0-9_./+-]{16,})["\']')
COMENTARIO = re.compile(r'^\s*(//|\*|/\*|#|--)')
FALSO = re.compile(
    r'process\.env|\$\{|<[A-Z_]+>|:latest|mockReturn|toBe\(|toEqual\(|expect\(|'
    r'example\.com|xxxx+|placeholder|\bfake[-_]|\bdummy[-_]|[-_]fixture|'
    r'\bvar\.|\blocal\.|\bdata\.', re.I)

# Janela de contexto: no terraform a chave e o valor ficam em linhas diferentes,
# com `type` e `description` no meio.
#   variable "db_password" {
#     type        = string
#     description = "..."
#     default     = "<segredo>"
JANELA = 4


def varrer(linhas):
    achados = []
    ctx = 0
    for linha in linhas:
        # ⚠️ o contexto NÃO pode atravessar arquivo nem hunk: uma chave no fim de
        # um arquivo casava com uma string longa no começo do seguinte.
        if linha.startswith('+++') or linha.startswith('diff --git') or linha.startswith('@@'):
            ctx = 0
            continue
        if not linha.startswith('+'):
            continue
        corpo = linha[1:].rstrip('\n')
        if COMENTARIO.match(corpo):
            continue
        suspeito = MESMA.search(corpo) or (ctx > 0 and VALOR.search(corpo))
        if suspeito and not FALSO.search(corpo):
            achados.append(corpo.strip())
        ctx = JANELA if CHAVE.search(corpo) else max(0, ctx - 1)
    return achados


def main():
    fonte = io.open(sys.argv[1], encoding='utf-8', errors='replace') if len(sys.argv) > 1 else sys.stdin
    for a in varrer(fonte):
        print(a)
    return 0


if __name__ == '__main__':
    sys.exit(main())
