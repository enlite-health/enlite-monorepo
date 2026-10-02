/**
 * BlockedApplicationQueryRepository.test.ts
 *
 * Testes unitários (mock de pool) para cobertura de branches defensivos
 * que não podem ser exercitados com banco real:
 *
 *   1. list() — missingFields = [] quando missing_fields não é array (branch ternário)
 *   2. list() — total = 0 quando countResult.rows[0] é undefined (branch ?? 0)
 *   3. aggregates() — byReason e totalBlocked corretos para múltiplas linhas
 *   4. list() — acquisitionChannel null (branch ?? null)
 *   5. listByVacancy() — retorna BlockedAttemptForFunnelDto corretamente (migration 230)
 *   6. listByVacancy() — missingFields=[] branch defensivo
 *   7. listByVacancy() — workerId null (worker_not_found)
 *
 * Nota: testes com banco real ficam em
 *   tests/e2e/blocked-application-repositories.integration.test.ts
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { BlockedApplicationQueryRepository, blockedNotPromotedSql } from '../BlockedApplicationQueryRepository';
import {
  liveWorkerJoinSql,
  liveBlockedReasonSql,
  liveMissingFieldsSql,
} from '../blockedAttemptLiveState';

const WORKER_ID   = 'aaaaaaaa-0000-0000-0000-111111111111';
const JOB_ID      = 'bbbbbbbb-0000-0000-0000-222222222222';
const ENTRY_ID    = 'cccccccc-0000-0000-0000-333333333333';
const NOW_DATE    = new Date('2026-01-01T00:00:00.000Z');

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ENTRY_ID,
    worker_id: WORKER_ID,
    job_posting_id: JOB_ID,
    blocked_reason: 'registration_incomplete',
    missing_fields: ['phone'],  // array (happy path)
    attempt_count: 1,
    first_attempted_at: NOW_DATE,
    last_attempted_at: NOW_DATE,
    acquisition_channel: 'facebook',
    created_at: NOW_DATE,
    updated_at: NOW_DATE,
    ...overrides,
  };
}

describe('BlockedApplicationQueryRepository', () => {
  let repo: BlockedApplicationQueryRepository;

  beforeEach(() => {
    mockQuery.mockReset();
    repo = new BlockedApplicationQueryRepository();
  });

  // ── list() — caminho feliz ───────────────────────────────────────

  it('lista retorna DTO mapeado corretamente (caminho feliz)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });         // data
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });     // count

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    expect(item.id).toBe(ENTRY_ID);
    expect(item.workerId).toBe(WORKER_ID);
    expect(item.jobPostingId).toBe(JOB_ID);
    expect(item.blockedReason).toBe('registration_incomplete');
    expect(item.missingFields).toEqual(['phone']);
    expect(item.attemptCount).toBe(1);
    expect(item.firstAttemptedAt).toBe(NOW_DATE.toISOString());
    expect(item.lastAttemptedAt).toBe(NOW_DATE.toISOString());
    expect(item.acquisitionChannel).toBe('facebook');
    expect(result.total).toBe(1);
  });

  it('missingFields = [] quando missing_fields não é array (branch defensivo)', async () => {
    // Cobre linha 108: `Array.isArray(r.missing_fields) ? r.missing_fields : []`
    // Branch falso: missing_fields retorna como string (caso hipotético)
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ missing_fields: 'not-an-array' })] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data[0].missingFields).toEqual([]);
  });

  it('total = 0 quando countResult.rows[0] é undefined (branch ?? 0)', async () => {
    // Cobre linha 119: `(countResult.rows[0]?.total as number) ?? 0`
    mockQuery.mockResolvedValueOnce({ rows: [] });    // data vazia
    mockQuery.mockResolvedValueOnce({ rows: [] });    // count: rows vazio → undefined

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('acquisitionChannel = null quando null no banco (branch ?? null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ acquisition_channel: null })] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data[0].acquisitionChannel).toBeNull();
  });

  it('filtros jobPostingId/workerId/reason constroem WHERE correto', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await repo.list({
      jobPostingId: JOB_ID,
      workerId: WORKER_ID,
      reason: 'worker_disabled',
      limit: 10,
      offset: 0,
    });

    const dataQueryCall = mockQuery.mock.calls[0][0] as string;
    expect(dataQueryCall).toContain('wba.job_posting_id = $1');
    expect(dataQueryCall).toContain('wba.worker_id = $2');
    // D300: o filtro passou a incidir sobre o motivo AO VIVO, não sobre a coluna
    // congelada — filtrar por um valor que a tela não exibe mais devolveria cards
    // que contradizem o próprio filtro.
    expect(dataQueryCall).toContain(`${liveBlockedReasonSql()} = $3`);
    expect(dataQueryCall).not.toContain('wba.blocked_reason = $3');
    expect(dataQueryCall).toContain('WHERE');
  });

  it('list() — recomputa MOTIVO e campos ao vivo, e não lê mais a coluna congelada', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await repo.list({ limit: 10, offset: 0 });

    const dataQueryCall = mockQuery.mock.calls[0][0] as string;
    expect(dataQueryCall).toContain(liveWorkerJoinSql());
    expect(dataQueryCall).toContain(`${liveBlockedReasonSql()} AS blocked_reason`);
    expect(dataQueryCall).toContain(`${liveMissingFieldsSql()} AS missing_fields`);
    // O snapshot não pode mais ser projetado: era ele que exibia o rótulo de meses atrás.
    expect(dataQueryCall).not.toContain('wba.missing_fields');
  });

  it('sem filtros: filtra apenas ativos (dismissed_at IS NULL) e LIMIT/OFFSET usam índices $1/$2', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await repo.list({ limit: 50, offset: 0 });

    const dataQueryCall = mockQuery.mock.calls[0][0] as string;
    // Migration 250: os "rechazados" (soft-dismiss) saem do painel — sempre há um WHERE base.
    expect(dataQueryCall).toContain('WHERE');
    expect(dataQueryCall).toContain('wba.dismissed_at IS NULL');
    // A condição base não consome placeholder → LIMIT/OFFSET seguem $1/$2.
    expect(dataQueryCall).toContain('LIMIT $1 OFFSET $2');
  });

  // ── aggregates() ─────────────────────────────────────────────────

  it('aggregates() com múltiplas reasons', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { blocked_reason: 'registration_incomplete', count: 5 },
        { blocked_reason: 'worker_disabled', count: 2 },
        { blocked_reason: 'worker_not_found', count: 1 },
      ],
    });

    const agg = await repo.aggregates();

    expect(agg.totalBlocked).toBe(8);
    expect(agg.byReason).toEqual({
      registration_incomplete: 5,
      worker_disabled: 2,
      worker_not_found: 1,
    });
  });

  it('aggregates() com tabela vazia → totalBlocked=0 e byReason={}', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const agg = await repo.aggregates();

    expect(agg.totalBlocked).toBe(0);
    expect(agg.byReason).toEqual({});
  });

  // ── listByVacancy() — migration 230 ──────────────────────────────
  // Usado pelo WJAFunnelController para montar a coluna INICIADO do kanban.

  it('listByVacancy() retorna BlockedAttemptForFunnelDto mapeado corretamente', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-1',
        worker_id: WORKER_ID,
        blocked_reason: 'registration_incomplete',
        missing_fields: ['profession', 'phone'],
        attempt_count: 3,
        acquisition_channel: 'facebook',
        last_attempted_at: NOW_DATE,
        contact_notes_count: 2,
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);

    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item.id).toBe('ba-1');
    expect(item.workerId).toBe(WORKER_ID);
    expect(item.blockedReason).toBe('registration_incomplete');
    expect(item.missingFields).toEqual(['profession', 'phone']);
    expect(item.attemptCount).toBe(3);
    expect(item.acquisitionChannel).toBe('facebook');
    expect(item.lastAttemptedAt).toBe(NOW_DATE.toISOString());
    expect(item.contactNotesCount).toBe(2);
  });

  it('listByVacancy() — contactNotesCount default 0 quando ausente/undefined (branch defensivo)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-1b',
        worker_id: WORKER_ID,
        blocked_reason: 'registration_incomplete',
        missing_fields: [],
        attempt_count: 1,
        acquisition_channel: null,
        last_attempted_at: NOW_DATE,
        // contact_notes_count ausente
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result[0].contactNotesCount).toBe(0);
  });

  it('listByVacancy() — SQL soma contact_notes_count filtrando pelo par (worker_id, job_posting_id)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await repo.listByVacancy(JOB_ID);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('wja_contact_notes cn');
    expect(sql).toContain('cn.worker_id = wba.worker_id');
    expect(sql).toContain('cn.job_posting_id = wba.job_posting_id');
    expect(sql).toContain('contact_notes_count');
  });

  it('listByVacancy() inclui NOT EXISTS para dedup (query SQL deve ter NOT EXISTS)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await repo.listByVacancy(JOB_ID);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('worker_job_applications');
    expect(sql).toContain('wja.worker_id  = wba.worker_id');
    expect(sql).toContain('wja.job_posting_id = wba.job_posting_id');
  });

  it('listByVacancy() — missingFields = [] quando missing_fields não é array (branch defensivo)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-2',
        worker_id: WORKER_ID,
        blocked_reason: 'registration_incomplete',
        missing_fields: null, // não é array
        attempt_count: 1,
        acquisition_channel: null,
        last_attempted_at: NOW_DATE,
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result[0].missingFields).toEqual([]);
  });

  it('listByVacancy() — workerId = null quando worker_not_found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-3',
        worker_id: null, // worker_not_found
        blocked_reason: 'worker_not_found',
        missing_fields: [],
        attempt_count: 1,
        acquisition_channel: null,
        last_attempted_at: NOW_DATE,
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result[0].workerId).toBeNull();
  });

  it('listByVacancy() — retorna lista vazia quando não há bloqueados', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result).toHaveLength(0);
  });

  // ── Regressão: staleness de missing_fields ───────────────────────
  // Histórico do defeito, em duas camadas:
  //   1º) editar o perfil atualizava o nome do card mas não as tags de campos
  //       faltantes, que vinham do snapshot. Consertou-se recomputando os CAMPOS.
  //   2º) o MOTIVO continuou congelado — e o recompute dos campos era condicionado
  //       a ele já ser `registration_incomplete`, ou seja, ao único caso em que
  //       nada muda. Em 08/09/2026, 135 de 1.271 cards em produção exibiam motivo
  //       errado, 90 deles de gente elegível. D300 recompõe as DUAS coisas.
  //
  // ⚠️ Estes asserts são de STRING: provam que a query pede o recálculo, não que o
  // Postgres a aceita. Um `ELSE '{}'::text[]` (tipo errado) passaria aqui e
  // quebraria em produção — aconteceu ao escrever a D300. A prova de execução está
  // em tests/e2e/blocked-attempt-live-state.test.ts, contra banco real.

  it('listByVacancy() — recomputa MOTIVO e campos ao vivo, sem projetar o snapshot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await repo.listByVacancy(JOB_ID);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain(liveWorkerJoinSql());
    expect(sql).toContain(`${liveBlockedReasonSql()} AS blocked_reason`);
    expect(sql).toContain(`${liveMissingFieldsSql()} AS missing_fields`);
    expect(sql).not.toContain('wba.missing_fields');
  });

  // ── listByWorker() — a aba de encuadre do prestador ───────────────
  //
  // Terceiro caminho de leitura do mesmo snapshot, e o único que nenhum teste
  // tocava. Foi por isso que ele passou despercebido na primeira metade do
  // conserto: quem procurou o defeito procurou onde já havia teste.

  it('listByWorker() — recomputa MOTIVO e campos ao vivo, como os outros dois caminhos', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await repo.listByWorker(WORKER_ID);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain(liveWorkerJoinSql());
    expect(sql).toContain(`${liveBlockedReasonSql()} AS blocked_reason`);
    expect(sql).toContain(`${liveMissingFieldsSql()} AS missing_fields`);
    expect(sql).not.toContain('wba.missing_fields');
  });

  it('listByWorker() — mapeia o card com vaga e paciente (caminho feliz)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: ENTRY_ID,
        job_posting_id: JOB_ID,
        case_number: 611,
        vacancy_number: 2,
        vacancy_status: 'SEARCHING_REPLACEMENT',
        patient_first_name: 'Ana',
        patient_last_name: 'Pérez',
        blocked_reason: 'registration_incomplete',
        missing_fields: ['years_experience', 'preferred_types'],
        attempt_count: 5,
        created_at: NOW_DATE,
      }],
    });

    const [card] = await repo.listByWorker(WORKER_ID);

    expect(card.caseNumber).toBe(611);
    expect(card.vacancyNumber).toBe(2);
    expect(card.patientName).toBe('Ana Pérez');
    expect(card.vacancyStatus).toBe('SEARCHING_REPLACEMENT');
    expect(card.blockedReason).toBe('registration_incomplete');
    expect(card.missingFields).toEqual(['years_experience', 'preferred_types']);
    expect(card.attemptCount).toBe(5);
    expect(card.isBlocked).toBe(true);
    expect(card.createdAt).toBe(NOW_DATE.toISOString());
  });

  it('listByWorker() — tudo nulo vira null, e paciente sem nome vira null (não string vazia)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: ENTRY_ID,
        job_posting_id: null,
        case_number: null,
        vacancy_number: null,
        vacancy_status: null,
        patient_first_name: null,
        patient_last_name: null,
        blocked_reason: null,
        missing_fields: null,
        attempt_count: null,
        created_at: NOW_DATE,
      }],
    });

    const [card] = await repo.listByWorker(WORKER_ID);

    expect(card.jobPostingId).toBeNull();
    expect(card.caseNumber).toBeNull();
    expect(card.vacancyNumber).toBeNull();
    expect(card.vacancyStatus).toBeNull();
    expect(card.patientName).toBeNull();
    expect(card.blockedReason).toBeNull();
    expect(card.missingFields).toEqual([]);
    expect(card.attemptCount).toBeNull();
  });

  it('listByVacancy() — card rechazado carrega dismissedAt em ISO (vai para RECHAZADOS)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: ENTRY_ID,
        worker_id: WORKER_ID,
        blocked_reason: 'registration_incomplete',
        missing_fields: [],
        attempt_count: 1,
        acquisition_channel: null,
        last_attempted_at: NOW_DATE,
        dismissed_at: NOW_DATE,
        dismissed_reason: 'OTHER',
        contact_notes_count: 0,
      }],
    });

    const [card] = await repo.listByVacancy(JOB_ID);

    expect(card.dismissedAt).toBe(NOW_DATE.toISOString());
    expect(card.dismissedReason).toBe('OTHER');
  });
});

describe('blockedNotPromotedSql', () => {
  it('usa o alias informado nas duas colunas do NOT EXISTS', () => {
    const sql = blockedNotPromotedSql('x');
    expect(sql).toContain('x.worker_id');
    expect(sql).toContain('x.job_posting_id');
  });
});

