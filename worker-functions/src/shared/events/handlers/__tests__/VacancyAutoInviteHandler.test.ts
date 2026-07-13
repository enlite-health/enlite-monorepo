/**
 * VacancyAutoInviteHandler.test.ts
 *
 * Cenários:
 *  1.  Payload sem jobPostingId lança erro
 *  2.  Job posting não encontrado → early return sem enfileirar
 *  2b. Vaga TEST sem workers TEST elegíveis na zona → SameRealmSpecification
 *      zera os candidatos no matchmaking → 0 WJA/0 outbox
 *  2b'.Vaga TEST com worker TEST elegível na zona → convida normalmente
 *  3.  Candidatos com alreadyApplied=true são filtrados (não enfileiram)
 *  4.  Candidato com EXISTS=true no outbox é skippado (idempotência)
 *  5a. Worker REGISTERED → INSERT outbox com slug=ar_vacancy_match_complete + 3 vars (sem pending_documents)
 *  5b. Worker INCOMPLETE_REGISTER → slug=ar_vacancy_match_incomplete + 4 vars com pending_documents
 *  6.  Worker status=null/desconhecido → skip (não enfileira)
 *  7.  Erro num candidato não bloqueia os próximos (loop continua)
 *  8.  workZone null → patient_zone usa fallback 'tu zona' (vem do JOIN do paciente, não do AT)
 *  9.  Usa TokenService.generate para worker_name (não plaintext)
 * 10.  formatPendingDocuments — helper retorna string correta dado worker_documents fictício (por profissão)
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

  // 2b — SameRealmSpecification (DataRealm.TEST) já filtra os candidatos dentro
  // do matchmaking: vaga TEST com zona só de workers LIVE não gera candidatos.
  it('vaga TEST com só workers LIVE na zona → matchmaking roda mas retorna 0 candidatos → 0 WJA/0 outbox', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ patient_zone: 'Palermo' }] });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-test-1' });

    expect(mockMatchWorkersForJob).toHaveBeenCalledTimes(1);
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  // 2b' — vaga TEST com um worker TEST elegível na zona → convida normalmente
  // (SameRealmSpecification deixou passar por casar TEST↔TEST).
  it('vaga TEST com worker TEST elegível na zona → convida o worker TEST normalmente', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Palermo' }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-test-realm-1' }] });

    const testCandidate = makeScoredCandidate({ workerId: 'worker-test-1', workerStatus: 'REGISTERED' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([testCandidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-test-1' });

    expect(mockCloudTasks.schedule).toHaveBeenCalledWith({
      queue: 'whatsapp-paced',
      url: '/api/internal/outbox/process-paced',
      body: { outboxId: 'outbox-test-realm-1' },
    });
  });

  // 2c' — job_postings.is_test=true (guarda de vaga de teste/QA, migration 248) →
  // handler faz early-return ANTES de rodar matchmaking. Isso é diferente de
  // 2b/2b': naquelas o realm TEST é resolvido dentro do MatchmakingService via
  // SameRealmSpecification; aqui é o próprio handler que lê jp.is_test na sua
  // query e corta o fluxo inteiro (matchmaking + WJA + outbox + WhatsApp).
  it('job_posting com is_test=true → retorna cedo sem chamar matchmaking nem inserir outbox', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ patient_zone: 'Palermo', is_test: true }] });

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-flagged-test' });

    expect(mockQuery).toHaveBeenCalledTimes(1); // só a SELECT inicial
    expect(mockMatchWorkersForJob).not.toHaveBeenCalled();
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  // 2c — vaga normal continua funcionando como antes.
  it('vaga LIVE → comportamento inalterado (matchmaking roda normalmente)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Palermo' }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-normal-1' }] });

    const candidate = makeScoredCandidate({ workerId: 'worker-1', workerStatus: 'REGISTERED' });
    mockMatchWorkersForJob.mockResolvedValueOnce(makeMatchResult([candidate]));

    const handler = createVacancyAutoInviteHandler(mockDb as never, mockCloudTasks as never);
    await handler({ jobPostingId: 'job-1' });

    expect(mockMatchWorkersForJob).toHaveBeenCalledTimes(1);
    expect(mockCloudTasks.schedule).toHaveBeenCalledWith({
      queue: 'whatsapp-paced',
      url: '/api/internal/outbox/process-paced',
      body: { outboxId: 'outbox-normal-1' },
    });
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
    expect(vars.vacancy_url).toBe('https://app.enlite.health/vacantes/job-1');
    expect(vars.pending_documents).toBeUndefined(); // NÃO deve existir para template complete

    expect(mockCloudTasks.schedule).toHaveBeenCalledWith({
      queue: 'whatsapp-paced',
      url: '/api/internal/outbox/process-paced',
      body: { outboxId: 'outbox-99' },
    });
  });

  // 5b
  it('worker INCOMPLETE_REGISTER → slug=ar_vacancy_match_incomplete com 4 vars incluindo pending_documents (sem seguro/matrícula)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ patient_zone: 'Flores' }] })    // SELECT patient_zone
      .mockResolvedValueOnce({ rows: [{ exists: false }] })              // opt-out check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })              // cooldown check
      .mockResolvedValueOnce({ rows: [{ exists: false }] })              // SELECT EXISTS outbox
      // formatPendingDocuments: JOIN workers + worker_documents (AT sem CV e sem at_certificate)
      .mockResolvedValueOnce({ rows: [{
        profession: 'AT',
        has_documents: true,
        identity_document_url: 'http://example.com/rg.pdf',
        identity_document_back_url: 'http://example.com/rg-verso.pdf',
        criminal_record_url: null,
        resume_cv_url: null,
        at_certificate_url: null,
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
    expect(vars.vacancy_url).toBe('https://app.enlite.health/vacantes/job-1');
    // Deve mencionar o que está faltando (antecedentes, CV, certificado AT)
    expect(vars.pending_documents).toContain('tus antecedentes penales');
    expect(vars.pending_documents).toContain('tu CV');
    expect(vars.pending_documents).toContain('tu certificado de AT');
    // NÃO deve citar seguro ou matrícula (não são obrigatórios)
    expect(vars.pending_documents).not.toContain('seguro');
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
  // Helper to build a mock db that returns the given row for the JOIN query
  const makeDb = (rows: object[]) => ({
    query: jest.fn().mockResolvedValue({ rows }),
  }) as never;

  // ─── Worker AT ─────────────────────────────────────────────────────────────

  it('AT sem at_certificate → cita "tu certificado de AT", NÃO cita seguro nem matrícula', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: 'http://antec.pdf',
      resume_cv_url: 'http://cv.pdf',
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-at');
    expect(result).toBe('tu certificado de AT');
    expect(result).not.toContain('seguro');
    expect(result).not.toContain('matrícula');
  });

  it('AT faltando CV e at_certificate → lista ambos com "y"', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: 'http://antec.pdf',
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-at');
    expect(result).toBe('tu CV y tu certificado de AT');
  });

  it('AT faltando tudo → lista os 4 obrigatórios (verso opcional) sem seguro/matrícula', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: true,
      identity_document_url: null,
      identity_document_back_url: null,
      criminal_record_url: null,
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-at');
    expect(result).toContain('tu DNI');
    expect(result).not.toContain('el dorso'); // verso OPCIONAL desde mig 212
    expect(result).toContain('tus antecedentes penales');
    expect(result).toContain('tu CV');
    expect(result).toContain('tu certificado de AT');
    expect(result).not.toContain('seguro');
    expect(result).not.toContain('matrícula');
  });

  it('AT com todos os docs preenchidos → fallback "completar tu perfil"', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: 'http://antec.pdf',
      resume_cv_url: 'http://cv.pdf',
      at_certificate_url: 'http://at-cert.pdf',
    }]);
    const result = await formatPendingDocuments(db, 'worker-at');
    expect(result).toBe('completar tu perfil');
  });

  // ─── Worker Cuidador ────────────────────────────────────────────────────────

  it('Cuidador faltando apenas antecedentes → cita só antecedentes, NÃO cita CV nem at_certificate', async () => {
    const db = makeDb([{
      profession: 'CUIDADOR',
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: null,
      resume_cv_url: null,          // NULL mas não obrigatório para Cuidador
      at_certificate_url: null,     // NULL mas não obrigatório para Cuidador
    }]);
    const result = await formatPendingDocuments(db, 'worker-cuidador');
    expect(result).toBe('tus antecedentes penales');
    expect(result).not.toContain('CV');
    expect(result).not.toContain('certificado');
    expect(result).not.toContain('seguro');
    expect(result).not.toContain('matrícula');
  });

  it('Cuidador faltando DNI frente (verso opcional) → lista só a frente', async () => {
    const db = makeDb([{
      profession: 'CUIDADOR',
      has_documents: true,
      identity_document_url: null,
      identity_document_back_url: null,
      criminal_record_url: 'http://antec.pdf',
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-cuidador');
    expect(result).toBe('tu DNI'); // verso OPCIONAL desde mig 212 — não listado
  });

  // ─── Profession null (UNKNOWN → trata como Cuidador) ───────────────────────

  it('profession null → usa base set (2 docs), NÃO cita CV nem at_certificate', async () => {
    const db = makeDb([{
      profession: null,
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: null,
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-unknown');
    expect(result).toBe('tus antecedentes penales');
    expect(result).not.toContain('CV');
    expect(result).not.toContain('certificado');
  });

  // ─── Sem linha em worker_documents ──────────────────────────────────────────

  it('AT sem linha em worker_documents → lista os 4 obrigatórios (verso opcional)', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: false,
      identity_document_url: null,
      identity_document_back_url: null,
      criminal_record_url: null,
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-at-nodocs');
    expect(result).toContain('tu DNI');
    expect(result).not.toContain('el dorso'); // verso OPCIONAL desde mig 212
    expect(result).toContain('tus antecedentes penales');
    expect(result).toContain('tu CV');
    expect(result).toContain('tu certificado de AT');
    expect(result).not.toContain('seguro');
    expect(result).not.toContain('matrícula');
  });

  it('Cuidador sem linha em worker_documents → lista os 2 obrigatórios base (verso opcional)', async () => {
    const db = makeDb([{
      profession: 'CUIDADOR',
      has_documents: false,
      identity_document_url: null,
      identity_document_back_url: null,
      criminal_record_url: null,
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-cuidador-nodocs');
    expect(result).toContain('tu DNI');
    expect(result).not.toContain('el dorso'); // verso OPCIONAL desde mig 212
    expect(result).toContain('tus antecedentes penales');
    expect(result).not.toContain('CV');
    expect(result).not.toContain('certificado');
  });

  it('worker não encontrado (rows vazio) → lista base set (2 docs, verso opcional)', async () => {
    const db = makeDb([]);
    const result = await formatPendingDocuments(db, 'worker-missing');
    // profession null → UNKNOWN → base set: DNI + verso + antecedentes
    expect(result).toContain('tu DNI');
    expect(result).not.toContain('el dorso'); // verso OPCIONAL desde mig 212
    expect(result).toContain('tus antecedentes penales');
    expect(result).not.toContain('CV');
    expect(result).not.toContain('certificado');
  });

  // ─── Concatenação ───────────────────────────────────────────────────────────

  it('1 campo faltando → retorna string simples sem vírgulas nem "y"', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: 'http://antec.pdf',
      resume_cv_url: 'http://cv.pdf',
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-x');
    expect(result).toBe('tu certificado de AT');
    expect(result).not.toContain(',');
    expect(result).not.toContain(' y ');
  });

  it('2 campos faltando → concatena com " y "', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: 'http://antec.pdf',
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-x');
    expect(result).toBe('tu CV y tu certificado de AT');
  });

  it('3 campos faltando → vírgula entre os primeiros, "y" antes do último', async () => {
    const db = makeDb([{
      profession: 'AT',
      has_documents: true,
      identity_document_url: 'http://rg.pdf',
      identity_document_back_url: 'http://rg-verso.pdf',
      criminal_record_url: null,
      resume_cv_url: null,
      at_certificate_url: null,
    }]);
    const result = await formatPendingDocuments(db, 'worker-x');
    expect(result).toBe('tus antecedentes penales, tu CV y tu certificado de AT');
  });
});
