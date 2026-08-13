/**
 * VacancyInviteGuard.test.ts
 *
 * Unit tests for assertVacancyInviteAllowed — as 4 travas do disparo manual:
 *  (a) opt-out          → OPTED_OUT
 *  (b) cooldown 3d      → COOLDOWN
 *  (c) idempotência 7d  → ALREADY_INVITED
 *  (d) throttle não-resposta (unanswered>=3 && !hasEngaged) → UNANSWERED_THROTTLE
 *  (e) hasEngaged=true  → NÃO bloqueia mesmo com muitos convites
 *  (f) tudo limpo       → { allowed: true }
 *
 * O db.query é mockado retornando as linhas por ORDEM de chamada:
 *   1. opt-out     → { rows: [{ exists }] }
 *   2. cooldown    → { rows: [{ exists }] }
 *   3. idempotência→ { rows: [{ exists }] }
 *   4. unanswered  → { rows: [{ n }] }
 *   5. engaged     → { rows: [{ exists }] }
 */

import { Pool } from 'pg';
import { assertVacancyInviteAllowed } from '../VacancyInviteGuard';

// Helpers ────────────────────────────────────────────────────────────────────

function existsRow(value: boolean) {
  return { rows: [{ exists: value }] };
}
function countRow(n: number) {
  return { rows: [{ n }] };
}

function makeDb(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

const WORKER_ID = 'w-1';
const JOB_ID = 'job-1';

describe('assertVacancyInviteAllowed', () => {
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockQuery = jest.fn();
  });

  it('(a) opt-out bloqueia → OPTED_OUT (sem rodar checks seguintes)', async () => {
    mockQuery.mockResolvedValueOnce(existsRow(true)); // opt-out

    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID);

    expect(result).toEqual({
      allowed: false,
      code: 'OPTED_OUT',
      detail: 'Worker pediu para não receber mensagens (opt-out).',
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('(b) cooldown 3d bloqueia → COOLDOWN', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(true)); // cooldown

    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID);

    expect(result).toEqual({
      allowed: false,
      code: 'COOLDOWN',
      detail: 'Worker recebeu uma mensagem nos últimos 3 dias.',
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('(c) idempotência 7d bloqueia → ALREADY_INVITED', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(false)) // cooldown
      .mockResolvedValueOnce(existsRow(true)); // idempotência

    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID);

    expect(result).toEqual({
      allowed: false,
      code: 'ALREADY_INVITED',
      detail: 'Worker já foi convidado para esta vaga nos últimos 7 dias.',
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('(d) throttle bloqueia quando unanswered>=3 e !hasEngaged → UNANSWERED_THROTTLE', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(false)) // cooldown
      .mockResolvedValueOnce(existsRow(false)) // idempotência
      .mockResolvedValueOnce(countRow(4))      // unanswered = 4
      .mockResolvedValueOnce(existsRow(false)); // hasEngaged = false

    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID);

    expect(result).toEqual({
      allowed: false,
      code: 'UNANSWERED_THROTTLE',
      detail:
        'Worker já recebeu 4 convites de vaga sem nunca responder (nenhuma candidatura avançou de INVITED). Envio pausado até engajar.',
    });
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  it('(e) throttle NÃO bloqueia quando hasEngaged=true mesmo com muitos convites', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(false)) // cooldown
      .mockResolvedValueOnce(existsRow(false)) // idempotência
      .mockResolvedValueOnce(countRow(10))     // unanswered = 10
      .mockResolvedValueOnce(existsRow(true));  // hasEngaged = true

    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID);

    expect(result).toEqual({ allowed: true });
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  it('(f) tudo limpo → allowed:true', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(false)) // cooldown
      .mockResolvedValueOnce(existsRow(false)) // idempotência
      .mockResolvedValueOnce(countRow(1))      // unanswered = 1 (< 3)
      .mockResolvedValueOnce(existsRow(false)); // hasEngaged = false

    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID);

    expect(result).toEqual({ allowed: true });
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });
});
