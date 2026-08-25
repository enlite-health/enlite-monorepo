/**
 * C5 — o gate por coluna, isolado da máquina de CSV/XLSX.
 */

import {
  decidirColunas,
  COLUNAS_DE_DOSSIE,
  CELL_WORKER_PII_READ,
} from '../workerExportCells';
import { WORKER_EXPORT_COLUMN_KEYS } from '../workerExportColumns';
import type { WorkerExportColumnKey } from '../workerExportColumns';

const DOSSIE = [...COLUNAS_DE_DOSSIE];
const OPERACIONAIS: WorkerExportColumnKey[] = ['status', 'occupation', 'city', 'created_at'];

describe('decidirColunas — worker:export não dá o dossiê de brinde', () => {
  it('sem `worker_pii:read`, as 6 colunas de dossiê caem e o resto passa', () => {
    const { permitidas, negadas } = decidirColunas(['worker:export'], [...OPERACIONAIS, ...DOSSIE]);

    expect(negadas.sort()).toEqual([...DOSSIE].sort());
    expect(permitidas).toEqual(OPERACIONAIS);
  });

  it('com as DUAS células, o dossiê sai — a exigência é cumulativa, não alternativa', () => {
    const { permitidas, negadas } = decidirColunas(
      ['worker:export', CELL_WORKER_PII_READ],
      [...OPERACIONAIS, ...DOSSIE],
    );

    expect(negadas).toEqual([]);
    expect(permitidas).toEqual([...OPERACIONAIS, ...DOSSIE]);
  });

  it('`cells === null` devolve o que a rota já devolvia — D113', () => {
    const pedidas = [...OPERACIONAIS, ...DOSSIE];
    const { permitidas, negadas } = decidirColunas(null, pedidas);

    expect(negadas).toEqual([]);
    expect(permitidas).toEqual(pedidas);
  });

  it('`[]` NÃO é `null` — ator conhecido e sem célula perde o dossiê', () => {
    const { negadas } = decidirColunas([], [...DOSSIE]);
    expect(negadas.sort()).toEqual([...DOSSIE].sort());
  });

  it('a ordem pedida é preservada — o CSV não pode embaralhar coluna', () => {
    const { permitidas } = decidirColunas(['worker:export'], ['city', 'status', 'occupation']);
    expect(permitidas).toEqual(['city', 'status', 'occupation']);
  });

  it('as 6 do dossiê são exatamente estas, e todas existem no catálogo', () => {
    // Trava contra digitação: coluna inventada aqui nunca casaria nada e o gate
    // ficaria aberto para ela em silêncio.
    expect([...COLUNAS_DE_DOSSIE].sort()).toEqual([
      'address_line', 'birth_date', 'document_number', 'race', 'religion', 'sexual_orientation',
    ]);
    for (const c of COLUNAS_DE_DOSSIE) {
      expect([c, WORKER_EXPORT_COLUMN_KEYS.has(c)]).toEqual([c, true]);
    }
  });

  it('pedido só de operacionais não gera negativa — o gate não é ruído', () => {
    const { permitidas, negadas } = decidirColunas([], OPERACIONAIS);
    expect(negadas).toEqual([]);
    expect(permitidas).toEqual(OPERACIONAIS);
  });
});
