/**
 * F4 (T409) — i18n do seletor de área e da `/no-access`: o namespace `areas` tem as MESMAS chaves
 * em es e pt-BR (todas não vazias), e toda chave literal usada pelos dois componentes existe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import esJson from '../locales/es.json';
import ptBRJson from '../locales/pt-BR.json';

type Tree = { [k: string]: string | Tree };
const leaves = (t: Tree, prefix = ''): string[] =>
  Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`)));
const get = (t: Tree, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Tree | undefined)?.[k], t);

const es = (esJson as unknown as Tree).areas as Tree;
const pt = (ptBRJson as unknown as Tree).areas as Tree;

const ROOT = join(__dirname, '../../..');
const source = [
  'presentation/components/features/areas/AreaSwitcher.tsx',
  'presentation/pages/NoAccessPage.tsx',
]
  .map((f) => readFileSync(join(ROOT, f), 'utf8'))
  .join('\n');

describe('areas — i18n (F4 T409)', () => {
  it('o namespace existe nos dois idiomas e não é vazio', () => {
    expect(leaves(es).length).toBeGreaterThan(0);
    expect(leaves(pt).length).toBeGreaterThan(0);
  });

  it('es e pt-BR têm exatamente as mesmas chaves, todas não vazias', () => {
    expect(leaves(pt).sort()).toEqual(leaves(es).sort());
    for (const k of leaves(es)) {
      expect(String(get(es, k)).trim().length, `es ${k}`).toBeGreaterThan(0);
      expect(String(get(pt, k)).trim().length, `pt ${k}`).toBeGreaterThan(0);
    }
  });

  it('toda chave literal `areas.*` usada pelos componentes existe nos dois idiomas', () => {
    const used = [...source.matchAll(/['"`](areas\.[A-Za-z0-9_.]+)['"`]/g)].map((m) => m[1].replace(/^areas\./, ''));
    expect(used.length).toBeGreaterThan(0);
    for (const k of used) {
      expect(get(es, k), `es ${k}`).toBeDefined();
      expect(get(pt, k), `pt ${k}`).toBeDefined();
    }
  });
});
