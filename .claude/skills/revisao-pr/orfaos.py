#!/usr/bin/env python3
"""
V2 do revisao-pr — import órfão INTRODUZIDO pelo diff.

Recebe um TSV `arquivo_atual<TAB>arquivo_da_base` e imprime, também em TSV:
  FALHA<TAB>arquivo<TAB>nome   — órfão que ESTE diff introduziu
  AVISO<TAB>arquivo<TAB>nome   — órfão que já existia na base (dívida herdada)
  ERRO <TAB>arquivo<TAB>motivo — não pôde ser lido (nunca vira ✅)
  LIDOS<TAB>n<TAB>             — quantos foram EFETIVAMENTE lidos

Separador é TAB porque nome de arquivo com '|' corrompia o relatório.
"""
import re
import sys
import io
import os

IMPORT = re.compile(r"import\s+(?:type\s+)?([^;'\"]*?)\s+from\s+['\"][^'\"]+['\"]", re.S)


def sem_comentario(src):
    """Bloco /* … */ INTEIRO e comentário de fim de linha.

    A 1ª versão só apagava a linha que ABRIA o bloco, então um `import`
    comentado no miolo virava "órfão" e bloqueava PR limpo. E `//` no fim da
    linha contava como USO do símbolo, escondendo órfão de verdade.
    """
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//.*$', '', src)


def nomes_importados(src):
    nomes = set()
    for m in IMPORT.finditer(src):
        clausula = m.group(1)
        chaves = re.search(r'\{(.*)\}', clausula, re.S)
        itens = chaves.group(1).split(',') if chaves else []
        itens += re.sub(r'\{.*\}', '', clausula, flags=re.S).split(',')
        for it in itens:
            it = it.strip()
            if not it:
                continue
            it = re.sub(r'^\*\s*', '', it)        # import * as X
            it = re.sub(r'^type\s+', '', it)      # import { type X }
            it = re.split(r'\bas\b', it)[-1].strip()   # nome LOCAL, por fronteira
            if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$]*', it):
                nomes.add(it)
    return nomes


def orfaos_de(caminho):
    """None = 'não sei' (arquivo ilegível). Diferente de set() = 'nenhum'."""
    if not os.path.isfile(caminho):
        return None
    src = sem_comentario(io.open(caminho, encoding='utf-8', errors='replace').read())
    corpo = IMPORT.sub('', src)
    return {n for n in nomes_importados(src)
            if not re.search(r'\b' + re.escape(n) + r'\b', corpo)}


def main():
    pares = [l.split('\t') for l in
             io.open(sys.argv[1], encoding='utf-8', errors='replace').read().split('\n')
             if '\t' in l]
    lidos = 0
    for atual_p, base_p in pares:
        atual = orfaos_de(atual_p)
        if atual is None:
            print("ERRO\t%s\tnão pôde ser lido" % atual_p)
            continue
        lidos += 1
        antes = orfaos_de(base_p) or set()
        for n in sorted(atual - antes):
            print("FALHA\t%s\t%s" % (atual_p, n))
        for n in sorted(atual & antes):
            print("AVISO\t%s\t%s" % (atual_p, n))
    print("LIDOS\t%d\t" % lidos)
    return 0


if __name__ == '__main__':
    sys.exit(main())
