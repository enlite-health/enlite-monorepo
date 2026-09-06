#!/usr/bin/env python3
"""
V3 do revisao-pr — quem ainda importa um arquivo APAGADO pelo diff.

⚠️ Duas armadilhas medidas, ambas com fixture em testar.sh:
  1. casar por BASENAME é falso positivo duro: o repo tem 23 basenames
     repetidos (`Result.ts`, `Table.tsx`, `TalentumWebhookController.ts`…).
     Apagar `a/Comum.ts` acusava quem importa `b/Comum` — e gate que reprova
     PR legítimo ensina o time a ignorar o ❌.
  2. casar só `from '…'` era cego ao ALIAS do tsconfig (`@shared/`,
     `@modules/` — a forma dominante do repo), ao `import()` dinâmico, ao
     `jest.mock()` e ao sufixo `.js`.

Resolve o caminho de verdade: relativo pelo diretório do importador, alias pelo
`paths` do tsconfig. Só acusa quando o alvo resolvido É o arquivo apagado.

Uso: importadores.py <arquivo_apagado> <raiz_do_repo> <arquivo_com_lista_de_ts>
"""
import json
import os
import re
import sys
import io

ESPEC = re.compile(
    r"""(?:from|import|require|jest\.mock)\s*\(?\s*['"]([^'"]+)['"]""")


def carrega_alias(raiz):
    """Lê `paths` do tsconfig — sem isso 600+ imports do repo ficam invisíveis."""
    alias = {}
    for nome in ('worker-functions/tsconfig.json', 'enlite-frontend/tsconfig.json', 'tsconfig.json'):
        caminho = os.path.join(raiz, nome)
        if not os.path.isfile(caminho):
            continue
        try:
            bruto = io.open(caminho, encoding='utf-8', errors='replace').read()
            bruto = re.sub(r'/\*.*?\*/', '', bruto, flags=re.S)
            bruto = re.sub(r'(?m)//.*$', '', bruto)
            cfg = json.loads(bruto)
        except Exception:
            continue
        co = cfg.get('compilerOptions', {})
        base = os.path.join(os.path.dirname(caminho), co.get('baseUrl', '.'))
        for chave, destinos in (co.get('paths') or {}).items():
            if destinos:
                alias[chave.rstrip('*').rstrip('/')] = os.path.normpath(
                    os.path.join(base, destinos[0].rstrip('*').rstrip('/')))
    return alias


def resolve(espec, dir_importador, alias):
    if espec.startswith('.'):
        return os.path.normpath(os.path.join(dir_importador, espec))
    for prefixo, destino in alias.items():
        if espec == prefixo or espec.startswith(prefixo + '/'):
            return os.path.normpath(os.path.join(destino, espec[len(prefixo):].lstrip('/')))
    return None


def main():
    apagado, raiz, lista = sys.argv[1], sys.argv[2], sys.argv[3]
    alvo = os.path.normpath(os.path.join(raiz, re.sub(r'\.(ts|tsx)$', '', apagado)))
    alias = carrega_alias(raiz)
    for arq in io.open(lista, encoding='utf-8', errors='replace').read().split('\n'):
        if not arq or arq == apagado or not os.path.isfile(os.path.join(raiz, arq)):
            continue
        src = io.open(os.path.join(raiz, arq), encoding='utf-8', errors='replace').read()
        d = os.path.dirname(os.path.join(raiz, arq))
        for m in ESPEC.finditer(src):
            espec = re.sub(r'\.(js|ts|tsx)$', '', m.group(1))
            r = resolve(espec, d, alias)
            if r and os.path.normpath(r) == alvo:
                linha = src[:m.start()].count('\n') + 1
                print("%s:%d:%s" % (arq, linha, m.group(0).strip()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
