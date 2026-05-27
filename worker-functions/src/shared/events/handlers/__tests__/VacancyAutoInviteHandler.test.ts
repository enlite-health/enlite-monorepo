/**
 * VacancyAutoInviteHandler.test.ts
 *
 * Cenários:
 *  1.  Payload sem jobPostingId lança erro
 *  2.  Job posting não encontrado → early return sem enfileirar
 *  3.  Candidatos com alreadyApplied=true são filtrados (não enfileiram)
 *  4.  Candidato com EXISTS=true no outbox é skippado (idempotência)
 *  5a. Worker REGISTERED → INSERT outbox com slug=ar_vacancy_match_complete + 3 vars (sem pending_documents)
 *  5b. Worker INCOMPLETE_REGISTER → slug=ar_vacancy_match_incomplete + 4 vars com pending_documents
 *  6.  Worker status=null/desconhecido → skip (não enfileira)
 *  7.  Erro num candidato não bloqueia os próximos (loop continua)
 *  8.  workZone null → patient_zone usa fallback 'tu zona' (vem do JOIN do paciente, não do AT)
 *  9.  Usa TokenService.generate para worker_name (não plaintext)
 * 10.  formatPendingDocuments — helper retorna string correta dado worker_documents fictício
 */

import { createVacancyAutoInviteHandler, formatPendingDocuments } from '../VacancyAutoInviteHandler';

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeScoredCandidate = (overrides: Partial<{
  workerId: string;
  workZone: string | null;
  distanceKm: number | null;
  alreadyApplied: boolean;
  workerStatus: string | null;
}> = {}) => ({
  workerId: 'worker-1',
  workerName: 'Test Worker',
  workerPhone: '+5491100000000',
  occupation: 'AT',
  workZone: 'Palermo',
  distanceKm: 5.2,
  activeCasesCount: 0,
  workerStatus: 'REGISTERED',
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

// ─── Shared mock state ────────────────────────────────────────────────────────

describe('VacancyAutoInviteHandler', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockCloudTasks: { schedule: jest.Mock };
  let mockMatchWorkersForJob: jest.Mock;
  let mockGenerate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    mockCloudTasks = { schedule: jest.fn().mockResolvedValue(null) };

    mockMatchWorkersForJob = jest.fn().mockResolvedValue(makeMatchResult([]));
    (MatchmakingService as jest.MockedClass<typeof MatchmakingService>).mockImplementation(() => ({
      matchWorkersForJob: mockMatchWorkersForJob,
    }) as unknown as MatchmakingService);

    mockGenerate = jest.fn().mockResolvedValue('tk_abc123def456');
    (TokenService as jest.MockedClass<typeof TokenService>).mockImplementation(() => ({
      generate: mockGenerate,
    }) as unknown as TokenService);
  });

  // 1
  it('lança erro se jobPostingId estiver ausente no payload', async () => {
    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await expect(handler({})).rejects.toThrow('Missing jobPostingId in vacancy.created payload');
  });

  // 2
  it('retorna early se job posting não encontrado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT patient_zone

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockMatchWorkersForJob).not.toHaveBeenCalled();
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  // 3
  it('candidatos com alreadyApplied=true são filtrados e não enfileiram', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ patient_zone: 'Palermo' }] }); // SELECT patient_zone

    const alreadyApplied = makeScoredCandidate({ alreadyApplied: true });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([alreadyApplied]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockQuery).toHaveBeenCalledTimes(1); // só SELECT patient_zone
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  // 4
  it('candidato com EXISTS=true no outbox é skippado (idempotência)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Villa Crespo' }] }) // SELECT patient_zone
      .mockResolvedValueOnce({ rows: [{ exists: false }] })                // opt-out check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })                // cooldown check
      .mockResolvedValueOnce({ rows: [{ exists: true }] });                // SELECT EXISTS outbox

    const candidate = makeScoredCandidate();
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  // 5a
  it('worker REGISTERED → INSERT outbox com slug=ar_vacancy_match_complete e 3 vars (sem pending_documents)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Palermo' }] })    // SELECT patient_zone
      .mockResolvedValueOnce({ rows: [{ exists: false }] })               // opt-out check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })               // cooldown check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })               // SELECT EXISTS outbox
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-99' }] });            // INSERT outbox RETURNING id

    const candidate = makeScoredCandidate({ workerId: 'worker-1', workerStatus: 'REGISTERED' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    const insertCall = mockQuery.mock.calls[4];
    expect(insertCall[0]).toContain('INSERT INTO messaging_outbox');
    expect(insertCall[1][0]).toBe('worker-1');                     // $1 worker_id
    expect(insertCall[1][1]).toBe('job-1');                        // $2 job_posting_id
    expect(insertCall[1][2]).toBe('ar_vacancy_match_complete');    // $3 template_slug

    const vars = JSON.parse(insertCall[1][3]);
    expect(vars.worker_name).toBe('tk_abc123def456');
    expect(vars.patient_zone).toBe('Palermo');
    expect(vars.vacancy_url).toBe('https://app.enlite.health/vacancies/job-1');
    expect(vars.pending_documents).toBeUndefined(); // NÃO deve existir para template complete

    expect(mockCloudTasks.schedule).toHaveBeenCalledWith({
      queue: 'whatsapp-paced',
      url: '/api/internal/outbox/process-paced',
      body: { outboxId: 'outbox-99' },
    });
  });

  // 5b
  it('worker INCOMPLETE_REGISTER → slug=ar_vacancy_match_incomplete com 4 vars incluindo pending_documents', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Flores' }] })    // SELECT patient_zone
      .mockResolvedValueOnce({ rows: [{ exists: false }] })              // opt-out check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })              // cooldown check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })              // SELECT EXISTS outbox
      // formatPendingDocuments query (worker_documents)
      .mockResolvedValueOnce({ rows: [{
        resume_cv_url: null,
        identity_document_url: 'http://example.com/rg.pdf',
        criminal_record_url: null,
        professional_registration_url: 'http://example.com/mat.pdf',
        liability_insurance_url: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-incomplete-1' }] }); // INSERT outbox

    const candidate = makeScoredCandidate({ workerId: 'worker-2', workerStatus: 'INCOMPLETE_REGISTER' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    const insertCall = mockQuery.mock.calls[5];
    expect(insertCall[1][2]).toBe('ar_vacancy_match_incomplete'); // $3 template_slug

    const vars = JSON.parse(insertCall[1][3]);
    expect(vars.worker_name).toBe('tk_abc123def456');
    expect(vars.patient_zone).toBe('Flores');
    expect(vars.vacancy_url).toBe('https://app.enlite.health/vacancies/job-1');
    expect(vars.pending_documents).toContain('tu CV');
    expect(vars.pending_documents).toContain('tus antecedentes penales');
    expect(vars.pending_documents).toContain('tu seguro de responsabilidad civil');
    expect(vars.pending_documents).not.toContain('tu DNI');
    expect(vars.pending_documents).not.toContain('matrícula');

    expect(mockCloudTasks.schedule).toHaveBeenCalledWith({
      queue: 'whatsapp-paced',
      url: '/api/internal/outbox/process-paced',
      body: { outboxId: 'outbox-incomplete-1' },
    });
  });

  // 6
  it('worker com status=null/desconhecido → skip sem enfileirar', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ patient_zone: 'Caballito' }] }); // SELECT patient_zone

    const candidate = makeScoredCandidate({ workerStatus: null });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    // Apenas a query inicial — sem SELECT EXISTS, sem INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  // 7
  it('erro num candidato não bloqueia os próximos (loop continua)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Palermo' }] })    // SELECT patient_zone
      .mockRejectedValueOnce(new Error('DB error on candidate 1'))        // opt-out falha no candidato 1
      // candidato 2 segue normalmente:
      .mockResolvedValueOnce({ rows: [{ exists: false }] })               // opt-out check c2
      .mockResolvedValueOnce({ rows: [{ exists: false }] })               // cooldown check c2
      .mockResolvedValueOnce({ rows: [{ exists: false }] })               // EXISTS outbox c2
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] });             // INSERT c2

    const c1 = makeScoredCandidate({ workerId: 'worker-1', workerStatus: 'REGISTERED' });
    const c2 = makeScoredCandidate({ workerId: 'worker-2', workerStatus: 'REGISTERED' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([c1, c2]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await expect(handler({ jobPostingId: 'job-1' })).resolves.toBeUndefined();

    expect(mockCloudTasks.schedule).toHaveBeenCalledTimes(1);
    expect(mockCloudTasks.schedule).toHaveBeenCalledWith({
      queue: 'whatsapp-paced',
      url: '/api/internal/outbox/process-paced',
      body: { outboxId: 'outbox-2' },
    });
  });

  // 8 — patient_zone agora vem do DB (JOIN com patients), não do AT workZone
  it('patient_zone null no DB → usa fallback "tu zona"', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: null }] })  // SELECT patient_zone retorna null
      .mockResolvedValueOnce({ rows: [{ exists: false }] })        // opt-out check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })        // cooldown check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })        // EXISTS outbox
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });     // INSERT outbox

    const candidate = makeScoredCandidate({ workerStatus: 'REGISTERED' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    const vars = JSON.parse(mockQuery.mock.calls[4][1][3]);
    expect(vars.patient_zone).toBe('tu zona');
  });

  // 9
  it('usa TokenService.generate para worker_name (não plaintext)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Recoleta' }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })        // opt-out check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })        // cooldown check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })        // EXISTS outbox
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });     // INSERT outbox

    const candidate = makeScoredCandidate({ workerId: 'worker-xyz', workerStatus: 'REGISTERED' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockGenerate).toHaveBeenCalledWith('worker-xyz', 'worker_name');
    const vars = JSON.parse(mockQuery.mock.calls[4][1][3]);
    expect(vars.worker_name).toBe('tk_abc123def456');
    expect(vars.worker_name).toMatch(/^tk_/);
  });
});

// ─── formatPendingDocuments unit tests ───────────────────────────────────────

describe('formatPendingDocuments', () => {
  it('sem linha em worker_documents → todos os campos faltando', async () => {
    const mockDb = { query: jest.fn().mockResolvedValue({ rows: [] }) } as never;
    const result = await formatPendingDocuments(mockDb, 'worker-x');
    expect(result).toContain('tu CV');
    expect(result).toContain('tu DNI');
    expect(result).toContain('tus antecedentes penales');
    expect(result).toContain('tu matrícula profesional');
    expect(result).toContain('tu seguro de responsabilidad civil');
  });

  it('1 campo faltando → retorna string simples sem vírgulas', async () => {
    const mockDb = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          resume_cv_url: 'http://cv.pdf',
          identity_document_url: 'http://rg.pdf',
          criminal_record_url: null,
          professional_registration_url: 'http://mat.pdf',
          liability_insurance_url: 'http://seg.pdf',
        }],
      }),
    } as never;
    const result = await formatPendingDocuments(mockDb, 'worker-x');
    expect(result).toBe('tus antecedentes penales');
  });

  it('2 campos faltando → concatena com " y "', async () => {
    const mockDb = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          resume_cv_url: null,
          identity_document_url: null,
          criminal_record_url: 'http://antec.pdf',
          professional_registration_url: 'http://mat.pdf',
          liability_insurance_url: 'http://seg.pdf',
        }],
      }),
    } as never;
    const result = await formatPendingDocuments(mockDb, 'worker-x');
    expect(result).toBe('tu CV y tu DNI');
  });

  it('3 campos faltando → vírgula entre os primeiros, "y" antes do último', async () => {
    const mockDb = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          resume_cv_url: null,
          identity_document_url: null,
          criminal_record_url: null,
          professional_registration_url: 'http://mat.pdf',
          liability_insurance_url: 'http://seg.pdf',
        }],
      }),
    } as never;
    const result = await formatPendingDocuments(mockDb, 'worker-x');
    expect(result).toBe('tu CV, tu DNI y tus antecedentes penales');
  });

  it('todos os campos preenchidos → fallback "completar tu perfil"', async () => {
    const mockDb = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          resume_cv_url: 'http://cv.pdf',
          identity_document_url: 'http://rg.pdf',
          criminal_record_url: 'http://antec.pdf',
          professional_registration_url: 'http://mat.pdf',
          liability_insurance_url: 'http://seg.pdf',
        }],
      }),
    } as never;
    const result = await formatPendingDocuments(mockDb, 'worker-x');
    expect(result).toBe('completar tu perfil');
  });
});
