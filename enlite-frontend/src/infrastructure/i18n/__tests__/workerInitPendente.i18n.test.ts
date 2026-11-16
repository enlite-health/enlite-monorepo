/**
 * DP-20 — i18n do init pendente ("Revisá tu correo", espera do 429, tela do 1º login): o namespace `claim` tem as MESMAS
 * chaves em es e pt-BR (todas não vazias), e toda chave `claim.*` literal usada pelas telas novas existe nos dois.
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

const es = esJson as unknown as Tree;
const pt = ptBRJson as unknown as Tree;
const ROOT = join(__dirname, '../../..');
const source = [
  'presentation/components/features/auth/WorkerInitOutcomePanel.tsx',
  'presentation/pages/WorkerAccountCheckPage.tsx',
].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');

describe('claim — i18n do init pendente (DP-20)', () => {
  it('es e pt-BR têm exatamente as mesmas chaves em `claim`, todas não vazias', () => {
    expect(leaves(pt.claim as Tree).sort()).toEqual(leaves(es.claim as Tree).sort());
    for (const k of leaves(es.claim as Tree)) {
      expect(String(get(es.claim as Tree, k)).trim().length, `es ${k}`).toBeGreaterThan(0);
      expect(String(get(pt.claim as Tree, k)).trim().length, `pt ${k}`).toBeGreaterThan(0);
    }
  });

  it('toda chave literal das telas novas existe nos dois idiomas (sem texto fixo)', () => {
    const usadas = [...source.matchAll(/t\('(claim\.[\w.]+)'/g)].map((m) => m[1]);
    expect(usadas.length).toBeGreaterThanOrEqual(10);
    for (const k of usadas) {
      expect(typeof get(es, k), `es ${k}`).toBe('string');
      expect(typeof get(pt, k), `pt ${k}`).toBe('string');
    }
  });
});
