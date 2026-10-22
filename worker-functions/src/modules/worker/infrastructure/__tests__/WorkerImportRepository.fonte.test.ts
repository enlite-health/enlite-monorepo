/**
 * Spec 067 FR-02 / T020 — `recalculateStatus` não copia a regra de completude.
 *
 * A regra mora em `fn_worker_missing_fields` (migration 546). Este teste lê o FONTE de WorkerImportRepository.ts:
 * se a cópia inline voltar (lista de documento/campo no TS), ele reprova. E exercita a função com um pool falso para
 * provar que a query chama o dono.
 */
import * as fs from 'fs';
import * as path from 'path';
import { recalculateStatus } from '../WorkerImportRepository';

const fonte = fs.readFileSync(path.join(__dirname, '../WorkerImportRepository.ts'), 'utf8');

describe('WorkerImportRepository.recalculateStatus — um dono só (067 FR-02)', () => {
  it('o fonte tem 0 ocorrências de identity_document_url (a cópia da regra de documento saiu)', () => {
    expect(fonte.match(/identity_document_url/g) ?? []).toHaveLength(0);
    expect(fonte.match(/criminal_record_url/g) ?? []).toHaveLength(0);
  });

  it('a query decide por fn_worker_missing_fields(w.id) = []', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ current_status: 'INCOMPLETE_REGISTER', is_complete: true }] });
    const update = jest.fn().mockResolvedValue(undefined);
    const novo = await recalculateStatus({ query } as never, 'w-1', update);

    expect(String(query.mock.calls[0][0])).toContain(`fn_worker_missing_fields(w.id) = '[]'::jsonb`);
    expect(novo).toBe('REGISTERED');
    expect(update).toHaveBeenCalledWith('w-1', 'REGISTERED');
  });

  it('REGISTERED que deixou de ser completo é rebaixado; DISABLED nunca muda', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const q1 = jest.fn().mockResolvedValue({ rows: [{ current_status: 'REGISTERED', is_complete: false }] });
    expect(await recalculateStatus({ query: q1 } as never, 'w-1', update)).toBe('INCOMPLETE_REGISTER');

    const q2 = jest.fn().mockResolvedValue({ rows: [{ current_status: 'DISABLED', is_complete: false }] });
    expect(await recalculateStatus({ query: q2 } as never, 'w-2', update)).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
