/**
 * worker-merge-identity-move.test.ts
 *
 * Unit (client mockado) da fundação do vínculo self-service:
 *   moveUniqueIdentityFields → move phone/whatsapp/ana_care_id absorvido→survivor
 *     - ORDEM obrigatória: limpa o casco ANTES de gravar no survivor (os índices
 *       únicos idx_workers_phone_unique/idx_workers_ana_care_id_unique não
 *       filtram merged_into_id — caso Edith, 04/08)
 *     - só move o que o survivor NÃO tem; valor do survivor nunca é sobrescrito
 *     - phone e phone_encrypted viajam como unidade
 *   clearMovedFieldsFromSurvivor (via restoreSnapshot) → undo devolve o campo
 *     movido limpando o survivor ANTES do restore do absorvido (round-trip).
 */

jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));

import type { PoolClient } from 'pg';
import { moveUniqueIdentityFields } from '../WorkerPhoneMergeHelpers';
import { restoreSnapshot } from '../WorkerMergeSnapshotService';

const SURVIVOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const ABSORBED = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeClient(rowsByCall: Array<{ rows: unknown[]; rowCount?: number }>): {
  client: PoolClient;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let idx = 0;
  const client = {
    query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const resp = rowsByCall[idx] ?? { rows: [] };
      idx++;
      return Promise.resolve({ rowCount: resp.rows.length, ...resp });
    }),
  } as unknown as PoolClient;
  return { client, calls };
}

describe('moveUniqueIdentityFields', () => {
  it('move phone+ciphertext e ana_care_id quando survivor está vazio — limpando o casco ANTES', async () => {
    const { client, calls } = makeClient([
      {
        rows: [
          { id: SURVIVOR, phone: null, phone_encrypted: null, whatsapp_phone_encrypted: null, ana_care_id: null },
          { id: ABSORBED, phone: '5491133336012', phone_encrypted: 'ct-phone', whatsapp_phone_encrypted: 'ct-wa', ana_care_id: '90575' },
        ],
      },
      { rows: [] }, // UPDATE casco (limpa)
      { rows: [] }, // UPDATE survivor (grava)
    ]);

    const { fieldsMoved } = await moveUniqueIdentityFields(client, SURVIVOR, ABSORBED);

    expect(fieldsMoved).toEqual(['phone', 'phone_encrypted', 'whatsapp_phone_encrypted', 'ana_care_id']);

    // Ordem: SELECT → limpar casco → gravar survivor
    expect(calls).toHaveLength(3);
    const clearCall = calls[1];
    const setCall = calls[2];
    expect(clearCall.sql).toContain('= NULL');
    expect(clearCall.params).toEqual([ABSORBED]);
    expect(setCall.sql).not.toContain('= NULL');
    expect(setCall.params).toEqual(['5491133336012', 'ct-phone', 'ct-wa', '90575', SURVIVOR]);
  });

  it('NÃO sobrescreve valor que o survivor já tem (só move pros buracos)', async () => {
    const { client, calls } = makeClient([
      {
        rows: [
          { id: SURVIVOR, phone: '5491199999999', phone_encrypted: 'ct-s', whatsapp_phone_encrypted: null, ana_care_id: null },
          { id: ABSORBED, phone: '5491133336012', phone_encrypted: 'ct-a', whatsapp_phone_encrypted: 'ct-wa', ana_care_id: '90575' },
        ],
      },
      { rows: [] },
      { rows: [] },
    ]);

    const { fieldsMoved } = await moveUniqueIdentityFields(client, SURVIVOR, ABSORBED);

    // phone do survivor preservado; só whatsapp e ana_care_id migram
    expect(fieldsMoved).toEqual(['whatsapp_phone_encrypted', 'ana_care_id']);
    expect(calls[2].params).toEqual(['ct-wa', '90575', SURVIVOR]);
  });

  it('no-op quando o absorvido não tem nada a mover (nenhum UPDATE)', async () => {
    const { client, calls } = makeClient([
      {
        rows: [
          { id: SURVIVOR, phone: '549111', phone_encrypted: 'x', whatsapp_phone_encrypted: 'y', ana_care_id: '1' },
          { id: ABSORBED, phone: null, phone_encrypted: null, whatsapp_phone_encrypted: null, ana_care_id: null },
        ],
      },
    ]);

    const { fieldsMoved } = await moveUniqueIdentityFields(client, SURVIVOR, ABSORBED);

    expect(fieldsMoved).toEqual([]);
    expect(calls).toHaveLength(1); // só o SELECT
  });
});

describe('restoreSnapshot devolve campos movidos (round-trip do undo)', () => {
  it('limpa do survivor o valor que veio do move ANTES de restaurar o absorvido', async () => {
    const snapshot = {
      worker_row: {
        id: ABSORBED,
        email: 'old@example.com',
        phone: '5491133336012',
        phone_encrypted: 'ct-phone',
        ana_care_id: '90575',
        merged_into_id: null,
      },
      fk_rows: {},
    };

    const { client, calls } = makeClient([
      { rows: [{ id: 'snap-1', payload: snapshot, undone_at: null }] }, // SELECT snapshot
      { rows: [] },                                                    // UPDATE merged_into_id=NULL
      {
        // SELECT survivor (clearMovedFieldsFromSurvivor): survivor carrega o
        // phone e o ana_care_id EXATOS do snapshot → vieram do move
        rows: [{ phone: '5491133336012', phone_encrypted: 'ct-phone', whatsapp_phone_encrypted: 'ct-proprio', ana_care_id: '90575' }],
      },
      { rows: [] }, // UPDATE survivor (limpa movidos)
      { rows: [] }, // UPDATE restoreWorkerRow (absorvido de volta)
      { rows: [] }, // UPDATE undone_at
    ]);

    const result = await restoreSnapshot(client, {
      mergeAuditId: 42,
      survivorId: SURVIVOR,
      absorbedId: ABSORBED,
    });

    expect(result.alreadyUndone).toBe(false);

    // A limpeza do survivor acontece ANTES do restore do absorvido
    const clearCall = calls[3];
    const restoreCall = calls[4];
    expect(clearCall.sql).toContain('phone = NULL');
    expect(clearCall.sql).toContain('ana_care_id = NULL');
    // whatsapp do survivor NÃO bate com o snapshot → preservado
    expect(clearCall.sql).not.toContain('whatsapp_phone_encrypted = NULL');
    expect(clearCall.params).toEqual([SURVIVOR]);
    expect(restoreCall.sql).toContain('UPDATE workers SET');
    expect(restoreCall.params).toContain(ABSORBED);
  });
});
