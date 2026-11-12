/**
 * Paridade front × back dos pares (área, papel) que o registro de vínculos guarda (D514, um dono).
 *
 * O dono é `worker-functions/src/modules/identity/domain/Area.ts` (`STORED_AREA_ROLES`, espelho do CHECK
 * `area_membership_area_role`). O front só o ESPELHA em `domain/entities/AreaMembership.ts`; este teste lê o
 * arquivo do back como texto (os pacotes não compartilham resolução de módulo — mesmo padrão do
 * `permission-parity`) e exige igualdade. Fora do monorepo não há como conferir: avisa, não finge que passou.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STORED_AREA_ROLES } from '@domain/entities/AreaMembership';

const BACK_AREA_PATH = resolve(__dirname, '../../../worker-functions/src/modules/identity/domain/Area.ts');

/** Lê `{ care: ['family'], learn: [...] }` do `STORED_AREA_ROLES` do back. */
function paresDoBack(ts: string): Record<string, string[]> {
  const inicio = ts.indexOf('STORED_AREA_ROLES = {');
  if (inicio < 0) throw new Error('STORED_AREA_ROLES não encontrado em Area.ts');
  const fim = ts.indexOf('} as const', inicio);
  if (fim < 0) throw new Error('fechamento do STORED_AREA_ROLES não encontrado');
  const out: Record<string, string[]> = {};
  for (const m of ts.slice(inicio, fim).matchAll(/([a-z_]+)\s*:\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([a-z_]+)'/g)].map((r) => r[1]);
  }
  return out;
}

const pares = (o: Record<string, readonly string[]>): string[] =>
  Object.entries(o).flatMap(([a, rs]) => rs.map((r) => `${a}:${r}`)).sort();

describe('paridade front × back dos pares de vínculo de área', () => {
  it('o leitor acha pares no back — zero seria "não medi", não "igual"', () => {
    if (!existsSync(BACK_AREA_PATH)) { console.warn(`[paridade] ${BACK_AREA_PATH} não encontrado; a régua não rodou`); return; }
    expect(pares(paresDoBack(readFileSync(BACK_AREA_PATH, 'utf8'))).length).toBeGreaterThan(0);
  });

  it('🔴 STORED_AREA_ROLES do front é IGUAL ao do back (mesmas áreas, mesmos papéis)', () => {
    if (!existsSync(BACK_AREA_PATH)) { console.warn(`[paridade] ${BACK_AREA_PATH} não encontrado; a régua não rodou`); return; }
    expect(pares(STORED_AREA_ROLES)).toEqual(pares(paresDoBack(readFileSync(BACK_AREA_PATH, 'utf8'))));
  });
});
