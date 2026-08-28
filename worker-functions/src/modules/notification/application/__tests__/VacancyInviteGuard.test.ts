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
import { assertVacancyInviteAllowed, resendCooldownUntilSql } from '../VacancyInviteGuard';

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

  it('(g) query de unanswered sem linha (rows: []) → conta como 0, não bloqueia (?? 0)', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(false)) // cooldown
      .mockResolvedValueOnce(existsRow(false)) // idempotência
      .mockResolvedValueOnce({ rows: [] })     // unanswered: nenhuma linha devolvida
      .mockResolvedValueOnce(existsRow(false)); // hasEngaged = false

    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID);

    expect(result).toEqual({ allowed: true });
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });
});

// ── modo `resend` (botão "Reenviar" da tarjeta — REQ-08) ─────────────────────
// Ordem das queries no modo resend: 1. opt-out · 2. cooldown de reenvio (worker×vaga)
// · 3. unanswered · 4. engaged. NÃO consulta cooldown 3d nem idempotência 7d.

describe('assertVacancyInviteAllowed — mode: resend', () => {
  let mockQuery: jest.Mock;
  beforeEach(() => { mockQuery = jest.fn(); });

  it('opt-out continua bloqueando o reenvio → OPTED_OUT', async () => {
    mockQuery.mockResolvedValueOnce(existsRow(true));
    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID, { mode: 'resend' });
    expect(result).toMatchObject({ allowed: false, code: 'OPTED_OUT' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('reenvio dentro da janela (mesmo worker×vaga) → RESEND_COOLDOWN com `until` (quando a janela abre), janela em horas na query', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce({ rows: [{ until: new Date('2026-08-29T15:00:00Z') }] }); // já houve envio na janela
    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID, { mode: 'resend' });
    // D200.1: o `until` é o que o funil/card usam para desabilitar o botão ANTES do clique.
    expect(result).toMatchObject({ allowed: false, code: 'RESEND_COOLDOWN', until: '2026-08-29T15:00:00.000Z' });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/job_posting_id = \$2/);
    expect(sql).toMatch(/INTERVAL '1 hour'/);
    expect(params).toEqual([WORKER_ID, JOB_ID, 24]); // default MANUAL_RESEND_COOLDOWN_HOURS
  });

  it('a expressão SQL da janela é UMA só (guard e funil): resendCooldownUntilSql', () => {
    const sql = resendCooldownUntilSql('wja.worker_id', 'wja.job_posting_id', '$2');
    expect(sql).toMatch(/MAX\(dispatched_at\) \+ \(\$2 \* INTERVAL '1 hour'\)/);
    expect(sql).toMatch(/worker_id = wja\.worker_id/);
    expect(sql).toMatch(/job_posting_id = wja\.job_posting_id/);
    expect(sql).toMatch(/status = 'sent'/);
    expect(sql).toMatch(/dispatched_at > NOW\(\) - \(\$2 \* INTERVAL '1 hour'\)/);
  });

  it('fora da janela mas throttled (unanswered>=3, !engaged) → UNANSWERED_THROTTLE (o throttle vale para reenvio)', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(false)) // cooldown de reenvio
      .mockResolvedValueOnce(countRow(3))      // unanswered
      .mockResolvedValueOnce(existsRow(false)); // engaged
    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID, { mode: 'resend' });
    expect(result).toMatchObject({ allowed: false, code: 'UNANSWERED_THROTTLE' });
  });

  it('fora da janela e engajado → allowed (mesmo com convite há 2 dias: idempotência/cooldown 3d NÃO se aplicam)', async () => {
    mockQuery
      .mockResolvedValueOnce(existsRow(false)) // opt-out
      .mockResolvedValueOnce(existsRow(false)) // cooldown de reenvio
      .mockResolvedValueOnce(countRow(1))
      .mockResolvedValueOnce(existsRow(true));
    const result = await assertVacancyInviteAllowed(makeDb(mockQuery), WORKER_ID, JOB_ID, { mode: 'resend' });
    expect(result).toEqual({ allowed: true });
    expect(mockQuery).toHaveBeenCalledTimes(4);
    // Nenhuma das 4 queries é a idempotência de 7 dias
    for (const [sql] of mockQuery.mock.calls) expect(sql).not.toMatch(/7 days/);
  });
});

