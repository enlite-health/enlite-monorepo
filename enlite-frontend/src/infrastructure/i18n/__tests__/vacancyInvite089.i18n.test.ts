/**
 * 089 CA-15 — i18n da página "Invitar prestadores": paridade es × pt-BR e cobertura das chaves usadas no código.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import esJson from '../locales/es.json';
import ptBRJson from '../locales/pt-BR.json';

type Tree = { [k: string]: string | Tree };
const NS = 'admin.vacancyInvite';
const node = (json: unknown, path: string): Tree => path.split('.').reduce((o, k) => (o as Tree)[k] as Tree, json as Tree);
const leaves = (t: Tree, prefix = ''): string[] =>
  Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`)));
const has = (t: Tree, path: string): boolean => {
  const v = path.split('.').reduce<unknown>((o, k) => (o as Tree | undefined)?.[k], t);
  return v !== undefined;
};

const ROOT = join(__dirname, '../../..');
const files = [
  ...readdirSync(join(ROOT, 'presentation/pages/admin/VacancyInvite')).filter((f) => f.endsWith('.tsx')).map((f) => join(ROOT, 'presentation/pages/admin/VacancyInvite', f)),
  join(ROOT, 'hooks/admin/useInviteSending.ts'),
  join(ROOT, 'hooks/admin/useVacancyInviteBoard.ts'),
];
const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');

describe('admin.vacancyInvite — i18n (089 CA-15)', () => {
  const es = node(esJson, NS);
  const pt = node(ptBRJson, NS);

  it('es e pt-BR têm exatamente as mesmas chaves, todas não vazias', () => {
    expect(leaves(pt).sort()).toEqual(leaves(es).sort());
    for (const k of leaves(es)) {
      expect(String(k.split('.').reduce<unknown>((o, p) => (o as Tree)[p], es)).length, `es ${k}`).toBeGreaterThan(0);
      expect(String(k.split('.').reduce<unknown>((o, p) => (o as Tree)[p], pt)).length, `pt ${k}`).toBeGreaterThan(0);
    }
  });

  it('toda chave literal usada no código existe (plural _one/_other aceito; chave dinâmica: o grupo existe)', () => {
    const literal = [...source.matchAll(/['"`]admin\.vacancyInvite\.([A-Za-z0-9_.]+)['"`]/g)].map((m) => m[1]);
    const dynamic = [...source.matchAll(/`admin\.vacancyInvite\.([A-Za-z0-9_.]+)\.\$\{/g)].map((m) => m[1]);
    expect(literal.length).toBeGreaterThan(20);
    for (const k of literal) expect(has(es, k) || has(es, `${k}_other`), `chave ausente: ${k}`).toBe(true);
    for (const g of dynamic) expect(has(es, g), `grupo ausente: ${g}`).toBe(true);
  });

  it('textos exatos do inventário (es)', () => {
    expect(es.title).toBe('Invitar prestadores');
    expect(es.back).toBe('Volver a la vacante');
    expect((es.footer as Tree).invite_other).toBe('Invitar a {{count}} personas');
    expect((es.confirm as Tree).title).toBe('¿Enviar la invitación por WhatsApp?');
    expect((es.confirm as Tree).note).toBe('Los mensajes salen apenas confirmás y no se pueden cancelar.');
    expect((es.noService as Tree).title).toBe('No sabemos dónde es el servicio');
    expect((es.nobody as Tree).title).toBe('No encontramos prestadores hasta 50 km');
    expect((es.map as Tree).center).toBe('Lugar del servicio · fijo para esta vacante');
    expect((es.map as Tree).pin).toBe('{{name}}, {{distance}} km. Mostrar en la lista');
    expect((es.docs as Tree).switch).toBe('Solo con documentos completos');
  });
});
