/**
 * semaforo-da-vaga F3 — i18n do semáforo: paridade es × pt-BR (mesmas folhas, nenhuma vazia) e as chaves que o código usa.
 */
import { describe, it, expect } from 'vitest';
import esJson from '../locales/es.json';
import ptBRJson from '../locales/pt-BR.json';

type Tree = { [k: string]: string | Tree };
const NS = 'admin.semaphore';
const node = (json: unknown, path: string): Tree => path.split('.').reduce((o, k) => (o as Tree)[k] as Tree, json as Tree);
const leaves = (t: Tree, prefix = ''): string[] =>
  Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`)));
const get = (t: Tree, path: string): unknown => path.split('.').reduce<unknown>((o, p) => (o as Tree | undefined)?.[p], t);

describe('admin.semaphore — i18n (semaforo-da-vaga F3)', () => {
  const es = node(esJson, NS);
  const pt = node(ptBRJson, NS);

  it('es e pt-BR têm exatamente as mesmas chaves, todas não vazias', () => {
    expect(leaves(pt).sort()).toEqual(leaves(es).sort());
    for (const k of leaves(es)) {
      expect(String(get(es, k)).length, `es ${k}`).toBeGreaterThan(0);
      expect(String(get(pt, k)).length, `pt ${k}`).toBeGreaterThan(0);
    }
  });

  it('traz as chaves que as telas usam: título, filtro, 3 cores, aria com n e "sem semáforo"', () => {
    const esperadas = ['title', 'filterLabel', 'colors.red', 'colors.yellow', 'colors.green', 'dotAria', 'none'];
    for (const k of esperadas) {
      expect(leaves(es), `es ${k}`).toContain(k);
      expect(leaves(pt), `pt ${k}`).toContain(k);
    }
  });
});
