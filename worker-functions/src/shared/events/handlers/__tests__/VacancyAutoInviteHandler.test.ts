/**
 * VacancyAutoInviteHandler.test.ts
 *
 * Cenários:
 * 1. Payload sem jobPostingId lança erro
 * 2. Job posting não encontrado → early return sem enfileirar
 * 3. Candidatos com alreadyApplied=true são filtrados (não enfileiram)
 * 4. Candidato com EXISTS=true no outbox é skippado (idempotência)
 * 5. Candidato fresh → INSERT outbox + pubsub.publish chamado
 * 6. Erro num candidato não bloqueia os próximos (loop continua)
 * 7. distanceKm null → distance_km='?' nas variables
 * 8. workZone null → patient_zone='tu zona' (fallback)
 * 9. Usa TokenService.generate para worker_name (não plaintext)
 */

import { createVacancyAutoInviteHandler } from '../VacancyAutoInviteHandler';

// Mock MatchmakingService antes do import do handler
jest.mock('../../../../modules/matching/infrastructure/MatchmakingService', () => ({
  MatchmakingService: jest.fn().mockImplementation(() => ({
    matchWorkersForJob: jest.fn(),
  })),
}));

// Mock TokenService
jest.mock('../../../../modules/notification/infrastructure/TokenService', () => ({
  TokenService: jest.fn().mockImplementation(() => ({
    generate: jest.fn().mockResolvedValue('tk_abc123def456'),
  })),
}));

import { MatchmakingService } from '../../../../modules/matching/infrastructure/MatchmakingService';
import { TokenService } from '../../../../modules/notification/infrastructure/TokenService';

const makeScoredCandidate = (overrides: Partial<{
  workerId: string;
  workZone: string | null;
  distanceKm: number | null;
  alreadyApplied: boolean;
}> = {}) => ({
  workerId: 'worker-1',
  workerName: 'Test Worker',
  workerPhone: '+5491100000000',
  occupation: 'AT',
  workZone: 'Palermo',
  distanceKm: 5.2,
  activeCasesCount: 0,
  workerStatus: 'ACTIVE',
  registrationWarning: null,
  structuredScore: 80,
  llmScore: null,
  finalScore: 80,
  llmReasoning: null,
  llmRedFlags: [],
  llmStrengths: [],
  alreadyApplied: false,
  ...overrides,
});

const makeMatchResult = (candidates: ReturnType<typeof makeScoredCandidate>[]) => ({
  jobPostingId: 'job-1',
  radiusKm: 30,
  matchSummary: { hardFilteredCount: candidates.length, llmScoredCount: 0 },
  candidates,
});

describe('VacancyAutoInviteHandler', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockPubsub: { publish: jest.Mock };
  let mockMatchWorkersForJob: jest.Mock;
  let mockGenerate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    mockPubsub = { publish: jest.fn().mockResolvedValue(null) };

    // Acessa a instância mockada do MatchmakingService
    mockMatchWorkersForJob = jest.fn().mockResolvedValue(makeMatchResult([]));
    (MatchmakingService as jest.MockedClass<typeof MatchmakingService>).mockImplementation(() => ({
      matchWorkersForJob: mockMatchWorkersForJob,
    }) as unknown as MatchmakingService);

    // Acessa a instância mockada do TokenService
    mockGenerate = jest.fn().mockResolvedValue('tk_abc123def456');
    (TokenService as jest.MockedClass<typeof TokenService>).mockImplementation(() => ({
      generate: mockGenerate,
    }) as unknown as TokenService);
  });

  it('lança erro se jobPostingId estiver ausente no payload', async () => {
    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await expect(handler({})).rejects.toThrow('Missing jobPostingId in vacancy.created payload');
  });

  it('retorna early se job posting não encontrado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT job posting

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockMatchWorkersForJob).not.toHaveBeenCalled();
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('candidatos com alreadyApplied=true são filtrados e não enfileiram', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ case_number: 42 }] }); // SELECT job posting

    const alreadyApplied = makeScoredCandidate({ alreadyApplied: true });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([alreadyApplied]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await handler({ jobPostingId: 'job-1' });

    // Apenas a query inicial (SELECT case_number) + matchWorkersForJob — sem INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('candidato com EXISTS=true no outbox é skippado (idempotência)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ case_number: 42 }] }) // SELECT job posting
      .mockResolvedValueOnce({ rows: [{ exists: true }] });   // SELECT EXISTS outbox

    const candidate = makeScoredCandidate();
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockPubsub.publish).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('candidato fresh → INSERT outbox + pubsub.publish chamado', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ case_number: 42 }] })      // SELECT job posting
      .mockResolvedValueOnce({ rows: [{ exists: false }] })         // SELECT EXISTS outbox
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-99' }] });      // INSERT outbox RETURNING id

    const candidate = makeScoredCandidate({ workerId: 'worker-1', workZone: 'Palermo', distanceKm: 5.2 });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await handler({ jobPostingId: 'job-1' });

    // Verifica INSERT na outbox
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO messaging_outbox');
    // template_slug é passado como $3 (parâmetro, não inline no SQL)
    expect(insertCall[1][0]).toBe('worker-1');             // $1 worker_id
    expect(insertCall[1][1]).toBe('job-1');                // $2 job_posting_id
    expect(insertCall[1][2]).toBe('vacancy_invited_auto'); // $3 template_slug

    const vars = JSON.parse(insertCall[1][3]);             // $4 variables
    expect(vars.worker_name).toBe('tk_abc123def456'); // token, não plaintext
    expect(vars.vacancy_case_number).toBe('42');
    expect(vars.distance_km).toBe('5.2');
    expect(vars.patient_zone).toBe('Palermo');

    expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-99' });
  });

  it('erro num candidato não bloqueia os próximos (loop continua)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ case_number: 42 }] })      // SELECT job posting
      .mockRejectedValueOnce(new Error('DB error on candidate 1')) // EXISTS falha no candidato 1
      .mockResolvedValueOnce({ rows: [{ exists: false }] })        // EXISTS ok no candidato 2
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] });      // INSERT candidato 2

    const c1 = makeScoredCandidate({ workerId: 'worker-1' });
    const c2 = makeScoredCandidate({ workerId: 'worker-2' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([c1, c2]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    // Não deve lançar exceção
    await expect(handler({ jobPostingId: 'job-1' })).resolves.toBeUndefined();

    // Candidato 2 deve ter sido enfileirado apesar da falha no 1
    expect(mockPubsub.publish).toHaveBeenCalledTimes(1);
    expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-2' });
  });

  it('distanceKm null → distance_km="?" nas variables', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ case_number: 10 }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const candidate = makeScoredCandidate({ distanceKm: null });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await handler({ jobPostingId: 'job-1' });

    const vars = JSON.parse(mockQuery.mock.calls[2][1][3]);
    expect(vars.distance_km).toBe('?');
  });

  it('workZone null → patient_zone="tu zona" (fallback)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ case_number: 10 }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const candidate = makeScoredCandidate({ workZone: null });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await handler({ jobPostingId: 'job-1' });

    const vars = JSON.parse(mockQuery.mock.calls[2][1][3]);
    expect(vars.patient_zone).toBe('tu zona');
  });

  it('usa TokenService.generate para worker_name (não plaintext)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ case_number: 5 }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });

    const candidate = makeScoredCandidate({ workerId: 'worker-xyz' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockPubsub as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockGenerate).toHaveBeenCalledWith('worker-xyz', 'worker_name');
    const vars = JSON.parse(mockQuery.mock.calls[2][1][3]);
    expect(vars.worker_name).toBe('tk_abc123def456');
    // Garante que não é o nome em plaintext
    expect(vars.worker_name).toMatch(/^tk_/);
  });
});
