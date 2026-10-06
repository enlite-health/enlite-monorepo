/**
 * WorkerApplicationRepository.engagements.test.ts
 *
 * Testes unitários (mock de pool) para listEngagementsByWorker — a ficha do
 * prestador (aba Encuadres) precisa classificar o candidato do match como
 * COMPATIBLE (Fase 5, DX-5.1/DX-5.2) exatamente como o Kanban, e isso só se
 * prova passando `wja.messaged_at` para `deriveKanbanColumn` — hoje o único
 * teste que alcança este método (AdminWorkersController.test.ts) mocka o
 * repositório inteiro, então nunca exercitou a SQL nem o 3º argumento.
 *
 * Nota: nome sem `kanban|column|tab` de propósito (critério 14 do passo P3 —
 * fica fora do `--grep` de kanban-column do CI).
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { WorkerApplicationRepository } from '../WorkerApplicationRepository';

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-111111111111';

interface RowPartial {
  id: string;
  job_posting_id: string | null;
  funnel_stage: string | null;
  source: string | null;
  messaged_at: Date | null;
}

function dbRow(partial: RowPartial) {
  return {
    id: partial.id,
    job_posting_id: partial.job_posting_id,
    funnel_stage: partial.funnel_stage,
    source: partial.source,
    messaged_at: partial.messaged_at,
    case_number: null,
    vacancy_number: null,
    vacancy_status: null,
    patient_first_name: null,
    patient_last_name: null,
    resultado: null,
    interview_date: null,
    interview_time: null,
    recruiter_name: null,
    coordinator_name: null,
    rejection_reason: null,
    rejection_reason_category: null,
    attended: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('WorkerApplicationRepository.listEngagementsByWorker', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('candidato do match (INVITED/system/sem messaged_at) vira kanbanStage COMPATIBLE', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        dbRow({
          id: 'wja-1',
          job_posting_id: 'job-1',
          funnel_stage: 'INVITED',
          source: 'system',
          messaged_at: null,
        }),
      ],
    });

    const repo = new WorkerApplicationRepository();
    const [engagement] = await repo.listEngagementsByWorker(WORKER_ID);

    expect(engagement.kanbanStage).toBe('COMPATIBLE');
  });

  it('mensageado (messaged_at preenchido) vira kanbanStage INVITED, não COMPATIBLE', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        dbRow({
          id: 'wja-2',
          job_posting_id: 'job-2',
          funnel_stage: 'INVITED',
          source: 'system',
          messaged_at: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ],
    });

    const repo = new WorkerApplicationRepository();
    const [engagement] = await repo.listEngagementsByWorker(WORKER_ID);

    expect(engagement.kanbanStage).toBe('INVITED');
  });

  it('M6b (D474): a SQL esconde o convite do sistema do par com tentativa bloqueada ATIVA (a ficha mostra o card bloqueado)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await new WorkerApplicationRepository().listEngagementsByWorker(WORKER_ID);

    const sql: string = mockQuery.mock.calls[0][0];
    expect(sql).toMatch(/AND NOT \(\(wja\.application_funnel_stage = 'INVITED' AND wja\.source IS DISTINCT FROM 'manual'\)/);
    expect(sql).toContain('wba_dup.dismissed_at IS NULL');
  });

  it('a SQL enviada seleciona wja.messaged_at', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const repo = new WorkerApplicationRepository();
    await repo.listEngagementsByWorker(WORKER_ID);

    const sql: string = mockQuery.mock.calls[0][0];
    expect(sql).toContain('wja.messaged_at');
  });
});
