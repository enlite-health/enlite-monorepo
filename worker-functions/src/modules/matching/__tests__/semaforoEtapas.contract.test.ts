/**
 * TESTE DE CONTRATO — o par {SELECTED, QUICK_RESPONSE_TEAM} tem UMA declaração literal em `src/` (semaforo-da-vaga, F1).
 * Dono: `FILLED_POSITION_STAGES` (matching/domain/applicationFunnelStages.ts). O pool do itinerário
 * (`ALLOCATION_POOL_STAGES`) é reexport dele. Uma 2ª declaração literal reprova.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../..');
const DONO = 'modules/matching/domain/applicationFunnelStages.ts';
const PAR = /\[\s*['"]SELECTED['"]\s*,\s*['"]QUICK_RESPONSE_TEAM['"]\s*\]/g;

function arquivosDeFonte(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') arquivosDeFonte(p, acc);
    } else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}

describe('contrato: o par SELECTED + QUICK_RESPONSE_TEAM tem um dono só', () => {
  const achados = arquivosDeFonte(SRC).flatMap((f) => {
    const n = (readFileSync(f, 'utf8').match(PAR) ?? []).length;
    return n > 0 ? [{ arquivo: relative(SRC, f), n }] : [];
  });

  it('exatamente 1 declaração literal, e é a do dono', () => {
    expect(achados).toEqual([{ arquivo: DONO, n: 1 }]);
  });

  it('o pool do itinerário é o próprio dono (mesma referência)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ALLOCATION_POOL_STAGES } = require('../../case/domain/deriveServiceTeam');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FILLED_POSITION_STAGES } = require('../domain/applicationFunnelStages');
    expect(ALLOCATION_POOL_STAGES).toBe(FILLED_POSITION_STAGES);
  });
});
