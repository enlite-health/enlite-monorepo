/**
 * ProcessTalentumPrescreening.test.ts
 *
 * Testa:
 * - Emissão de domain events no fluxo QUALIFIED / NOT_QUALIFIED
 * - Auto-criação de worker quando não encontrado
 * - Auto-criação de encuadre para visibilidade no Kanban
 * - Progressão de application_funnel_stage a cada status do Talentum
 * - Proteção do sync contra regressão de stages do Talentum
 */

import { ProcessTalentumPrescreening, IWorkerLookup, IJobPostingLookup } from '../ProcessTalentumPrescreening';
import { TalentumPrescreeningResponseParsed } from '@modules/integration';
import { TalentumPrescreeningStatus } from '../../domain/TalentumPrescreening';
import { reportError } from '@shared/logging';

jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  reportError: jest.fn(),
}));

function buildPayload(overrides: {
  prescreeningId?: string;
  status?: 'INITIATED' | 'IN_PROGRESS' | 'COMPLETED' | 'ANALYZED';
  statusLabel?: 'QUALIFIED' | 'NOT_QUALIFIED' | 'PENDING' | 'IN_DOUBT';
  score?: number;
  profileId?: string;
  email?: string;
  phoneNumber?: string;
} = {}): TalentumPrescreeningResponseParsed {
  return {
    action: 'PRESCREENING_RESPONSE',
    subtype: overrides.status ?? 'ANALYZED',
    data: {
      prescreening: {
        id: overrides.prescreeningId ?? 'tp-1',
        name: 'Case Test',
      },
      profile: {
        id: overrides.profileId ?? 'prof-1',
        firstName: 'Juan',
        lastName: 'Perez',
        email: overrides.email ?? 'juan@test.com',
        phoneNumber: overrides.phoneNumber ?? '+5491100001111',
        registerQuestions: [],
      },
      response: {
        id: 'resp-1',
        state: [],
        score: overrides.score ?? 85,
        statusLabel: overrides.statusLabel ?? 'QUALIFIED',
      },
    },
  };
}

describe('ProcessTalentumPrescreening', () => {
  let mockPrescreeningRepo: any;
  let mockWorkerLookup: jest.Mocked<IWorkerLookup>;
  let mockJobPostingLookup: jest.Mocked<IJobPostingLookup>;
  let mockPoolClient: any;
  let mockPool: any;
  let mockPubsub: any;
  let useCase: ProcessTalentumPrescreening;

  beforeEach(() => {
    // Mock prescreening repo — upsertPrescreening passes through workerId/jobPostingId from input
    mockPrescreeningRepo = {
      upsertPrescreening: jest.fn().mockImplementation((dto: any) => Promise.resolve({
        prescreening: {
          id: 'ps-1',
          talentumPrescreeningId: dto.talentumPrescreeningId || 'tp-1',
          workerId: dto.workerId === undefined ? 'w-1' : dto.workerId,
          jobPostingId: dto.jobPostingId === undefined ? 'jp-1' : dto.jobPostingId,
        },
        created: true,
      })),
      upsertWorkerJobApplicationFromTalentum: jest.fn().mockResolvedValue({
        previousStage: null, // default: new application (no previous stage)
      }),
      upsertQuestion: jest.fn().mockResolvedValue({
        question: { id: 'q-1' },
        created: true,
      }),
      upsertResponse: jest.fn().mockResolvedValue({
        response: { id: 'r-1' },
        created: true,
      }),
    };

    // Mock worker lookup — always finds worker
    mockWorkerLookup = {
      findByEmail: jest.fn().mockResolvedValue({ getValue: () => ({ id: 'w-1' }) }),
      findByPhone: jest.fn().mockResolvedValue({ getValue: () => null }),
      findByCuit: jest.fn().mockResolvedValue({ getValue: () => null }),
    };

    // Mock job posting lookup
    mockJobPostingLookup = {
      findByTitleILike: jest.fn().mockResolvedValue({ id: 'jp-1' }),
    };

    // Mock pool client (transaction)
    mockPoolClient = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('domain_events')) {
          return Promise.resolve({ rows: [{ id: 'evt-uuid-123' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    // Mock pool — query usado por autoCreateWorker, autoCreateEncuadre e pela
    // resolução da cadeia de merge (resolveCanonicalWorkerId).
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockPoolClient),
      query: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        // Cadeia de merge (resolveCanonicalWorkerId): por padrão o worker está
        // vivo → linha mais profunda é ele mesmo, com merged_into_id null.
        // Os testes de merge sobrescrevem este mock.
        if (sql.includes('WITH RECURSIVE chain')) {
          return Promise.resolve({ rows: [{ id: params?.[0], depth: 0, merged_into_id: null }] });
        }
        if (sql.includes('INSERT INTO workers')) {
          return Promise.resolve({ rows: [{ id: 'w-auto' }] });
        }
        if (sql.includes('SELECT id FROM workers')) {
          return Promise.resolve({ rows: [{ id: 'w-auto' }] });
        }
        if (sql.includes('INSERT INTO encuadres')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    // Mock PubSub
    mockPubsub = {
      publish: jest.fn().mockResolvedValue('msg-id-1'),
    };

    useCase = new ProcessTalentumPrescreening(
      mockPrescreeningRepo,
      mockWorkerLookup,
      mockJobPostingLookup,
      mockPool,
      mockPubsub,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── 1. Insere domain_event ao transitar para QUALIFIED ───────────

  it('insere domain_event na transação ao transitar para QUALIFIED', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: 'SCREENED', // transitou de SCREENED → QUALIFIED
    });

    await useCase.execute(payload);

    // Verifica transação: BEGIN, upsert (via repo), INSERT domain_events, COMMIT
    expect(mockPoolClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockPoolClient.query).toHaveBeenCalledWith('COMMIT');

    // Verifica INSERT em domain_events
    const domainEventCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('domain_events'),
    );
    expect(domainEventCall).toBeDefined();
    expect(domainEventCall[0]).toContain('funnel_stage.qualified');
    // payload leva a ORIGEM (só medição — o handler loga `source`, B1 do gate 30/08)
    expect(JSON.parse(domainEventCall[1][0])).toEqual({ workerId: 'w-1', jobPostingId: 'jp-1', source: 'talentum' });

    // Client released
    expect(mockPoolClient.release).toHaveBeenCalled();
  });

  // ─── 2. Não insere se já era QUALIFIED (deduplicação) ─────────────

  it('não insere domain_event se previousStage já era QUALIFIED', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: 'QUALIFIED', // já era QUALIFIED — sem transição
    });

    await useCase.execute(payload);

    // Não deve ter INSERT em domain_events
    const domainEventCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('domain_events'),
    );
    expect(domainEventCall).toBeUndefined();

    // Pub/Sub não deve ser chamado
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  // ─── 3. NOT_QUALIFIED: auto-rejeição + domain event ────────────────

  it('auto-rejeita encuadre e emite domain_event ao transitar para NOT_QUALIFIED', async () => {
    const payload = buildPayload({ statusLabel: 'NOT_QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null, // primeira vez → transição
    });

    await useCase.execute(payload);

    // Verifica UPDATE encuadres com RECHAZADO + TALENTUM_NOT_QUALIFIED + WHERE resultado IS NULL
    const updateEncuadreCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE encuadres'),
    );
    expect(updateEncuadreCall).toBeDefined();
    expect(updateEncuadreCall[0]).toContain('RECHAZADO');
    expect(updateEncuadreCall[0]).toContain('TALENTUM_NOT_QUALIFIED');
    expect(updateEncuadreCall[0]).toContain('resultado IS NULL');
    expect(updateEncuadreCall[1]).toEqual(['w-1', 'jp-1']);

    // Verifica INSERT em domain_events com funnel_stage.not_qualified (auditoria da classificação)
    const notQualifiedEventCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('funnel_stage.not_qualified'),
    );
    expect(notQualifiedEventCall).toBeDefined();

    // Verifica UPDATE em worker_job_applications SET application_funnel_stage='REJECTED' (auto-reject)
    const updateWjaCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('UPDATE worker_job_applications') &&
        call[0].includes("'REJECTED'"),
    );
    expect(updateWjaCall).toBeDefined();
    expect(updateWjaCall[0]).toContain('application_funnel_stage');
    expect(updateWjaCall[1]).toEqual(['w-1', 'jp-1']);

    // Verifica INSERT em domain_events com funnel_stage.rejected (rastreabilidade do auto-reject)
    const rejectedEventCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('funnel_stage.rejected'),
    );
    expect(rejectedEventCall).toBeDefined();
    const rejectedPayload = JSON.parse(rejectedEventCall[1][0]);
    expect(rejectedPayload.source).toBe('auto_not_qualified');
    expect(rejectedPayload.workerId).toBe('w-1');
    expect(rejectedPayload.jobPostingId).toBe('jp-1');

    // Tudo na mesma transação
    expect(mockPoolClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockPoolClient.query).toHaveBeenCalledWith('COMMIT');

    // NOT_QUALIFIED não publica no Pub/Sub (só QUALIFIED tem tópico dedicado)
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('não re-executa auto-rejeição se previousStage já era REJECTED (deduplicação — webhook duplicado)', async () => {
    const payload = buildPayload({ statusLabel: 'NOT_QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: 'REJECTED', // já foi auto-rejeitado — não re-executa
    });

    await useCase.execute(payload);

    const updateCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE encuadres'),
    );
    expect(updateCall).toBeUndefined();

    const domainEventCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('domain_events'),
    );
    expect(domainEventCall).toBeUndefined();

    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('faz rollback se UPDATE encuadres falhar no fluxo NOT_QUALIFIED', async () => {
    const payload = buildPayload({ statusLabel: 'NOT_QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null,
    });

    mockPoolClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve();
      if (sql === 'COMMIT') return Promise.resolve();
      if (sql === 'ROLLBACK') return Promise.resolve();
      if (sql.includes('UPDATE encuadres')) {
        return Promise.reject(new Error('FK violation'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(useCase.execute(payload)).rejects.toThrow('FK violation');

    expect(mockPoolClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockPubsub.publish).not.toHaveBeenCalled();
    expect(mockPoolClient.release).toHaveBeenCalled();
  });

  // ─── 3b. PENDING: pula WJA upsert (Talentum ainda analisando) ────

  it('ANALYZED + PENDING → NÃO faz upsert de WJA (mantém stage atual)', async () => {
    const payload = buildPayload({ statusLabel: 'PENDING' });

    await useCase.execute(payload);

    expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).not.toHaveBeenCalled();
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  it('ANALYZED + PENDING → persiste status PENDING no prescreening', async () => {
    const payload = buildPayload({ statusLabel: 'PENDING' });

    await useCase.execute(payload);

    expect(mockPrescreeningRepo.upsertPrescreening).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING' }),
    );
  });

  // ─── 4. Não insere em dryRun ───────────────────────────────────────

  it('não insere domain_event nem faz upsert em dryRun', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });

    const result = await useCase.execute(payload, { dryRun: true });

    expect(result.prescreeningId).toBe('tp-1');
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(mockPubsub.publish).not.toHaveBeenCalled();
    expect(mockPrescreeningRepo.upsertPrescreening).not.toHaveBeenCalled();
  });

  // ─── 5. Publica no Pub/Sub após commit ─────────────────────────────

  it('publica no Pub/Sub com eventId após commit', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null, // nova application → transição para QUALIFIED
    });

    await useCase.execute(payload);

    expect(mockPubsub.publish).toHaveBeenCalledWith('talentum-prescreening-qualified', {
      eventId: 'evt-uuid-123',
    });

    // Pub/Sub publish é chamado APÓS commit
    const commitIndex = mockPoolClient.query.mock.calls.findIndex(
      (call: any[]) => call[0] === 'COMMIT',
    );
    expect(commitIndex).toBeGreaterThan(-1);
    // publish é chamado fora do client.query — verificamos apenas que foi chamado
    expect(mockPubsub.publish).toHaveBeenCalledTimes(1);
  });

  // ─── 5b. Pub/Sub falha é não-fatal ─────────────────────────────────

  it('Pub/Sub publish failure é não-fatal (não lança erro)', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null,
    });
    mockPubsub.publish.mockRejectedValue(new Error('Pub/Sub unavailable'));

    const result = await useCase.execute(payload);

    expect(result.prescreeningId).toBe('ps-1');
    expect(mockPubsub.publish).toHaveBeenCalled();
  });

  it('Pub/Sub failure sem .message (valor não-Error) é não-fatal', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null,
    });
    mockPubsub.publish.mockRejectedValue('raw string rejection');

    const result = await useCase.execute(payload);
    expect(result.prescreeningId).toBe('ps-1');
  });

  // ─── 5c. score undefined → default 0 ────────────────────────────────

  it('score undefined → usa 0 como matchScore no WJA upsert', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    (payload.data.response as any).score = undefined;
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null,
    });

    await useCase.execute(payload);

    expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
      expect.objectContaining({ matchScore: 0 }),
      mockPoolClient,
    );
  });

  // ─── 6. Rollback se INSERT domain_events falhar ────────────────────

  it('faz rollback se INSERT em domain_events falhar', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null,
    });

    // Faz o INSERT em domain_events falhar
    mockPoolClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve();
      if (sql === 'COMMIT') return Promise.resolve();
      if (sql === 'ROLLBACK') return Promise.resolve();
      if (sql.includes('domain_events')) {
        return Promise.reject(new Error('DB constraint violation'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(useCase.execute(payload)).rejects.toThrow('DB constraint violation');

    expect(mockPoolClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockPubsub.publish).not.toHaveBeenCalled();
    expect(mockPoolClient.release).toHaveBeenCalled();
  });

  // ─── 7. Status não-ANALYZED: upsert application com prescreening.status, sem domain event ──

  it('faz upsert em worker_job_applications com status IN_PROGRESS mas não emite domain event', async () => {
    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;

    await useCase.execute(payload);

    // Deve chamar upsert com o status do prescreening como funnel stage
    expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
      expect.objectContaining({ applicationFunnelStage: 'IN_PROGRESS' }),
      mockPoolClient,
    );

    // Não deve emitir domain event (não é QUALIFIED)
    const domainEventCall = mockPoolClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('domain_events'),
    );
    expect(domainEventCall).toBeUndefined();
    expect(mockPubsub.publish).not.toHaveBeenCalled();
  });

  // ─── 8. previousStage null = primeira application → transição ──────

  it('trata previousStage null como transição (primeira application)', async () => {
    const payload = buildPayload({ statusLabel: 'QUALIFIED' });
    mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
      previousStage: null, // primeira vez — null !== 'QUALIFIED'
    });

    await useCase.execute(payload);

    // Deve emitir evento
    expect(mockPubsub.publish).toHaveBeenCalledWith('talentum-prescreening-qualified', {
      eventId: 'evt-uuid-123',
    });
  });

  // ─── 9. upsertQuestions para registerQuestions e response.state ────

  it('faz upsert de registerQuestions e response.state', async () => {
    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;
    payload.data.profile.registerQuestions = [
      { questionId: 'q1', question: 'Experiência?', answer: 'Sim', responseType: 'text' },
    ];
    payload.data.response.state = [
      { questionId: 'q2', question: 'Disponibilidade?', answer: 'Manhã' },
    ];

    await useCase.execute(payload);

    // upsertQuestion chamado 2x (1 register + 1 prescreening)
    expect(mockPrescreeningRepo.upsertQuestion).toHaveBeenCalledTimes(2);
    expect(mockPrescreeningRepo.upsertResponse).toHaveBeenCalledTimes(2);

    // Verifica source='register' para registerQuestions
    expect(mockPrescreeningRepo.upsertResponse).toHaveBeenCalledWith(
      expect.objectContaining({ responseSource: 'register' }),
    );
    // Verifica source='prescreening' para response.state
    expect(mockPrescreeningRepo.upsertResponse).toHaveBeenCalledWith(
      expect.objectContaining({ responseSource: 'prescreening' }),
    );
  });

  // ─── 10. resolveWorkerId — fallback phone → cuil ───────────────────

  it('resolve worker por phone quando email não encontra', async () => {
    mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => null });
    mockWorkerLookup.findByPhone.mockResolvedValue({ getValue: () => ({ id: 'w-phone' }) });

    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;

    const result = await useCase.execute(payload);
    expect(result.workerId).toBe('w-phone');
  });

  it('resolve worker por cuil quando email e phone não encontram', async () => {
    mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => null });
    mockWorkerLookup.findByPhone.mockResolvedValue({ getValue: () => null });
    mockWorkerLookup.findByCuit.mockResolvedValue({ getValue: () => ({ id: 'w-cuil' }) });

    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;
    payload.data.profile.cuil = '20-12345678-9';

    const result = await useCase.execute(payload);
    expect(result.workerId).toBe('w-cuil');
  });

  it('auto-cria worker se nenhum lookup encontra (e retorna workerId do auto-criado)', async () => {
    mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => null });
    mockWorkerLookup.findByPhone.mockResolvedValue({ getValue: () => null });

    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;

    const result = await useCase.execute(payload);
    // Worker auto-criado pelo pool.query INSERT INTO workers
    expect(result.workerId).toBe('w-auto');

    // Verifica que INSERT INTO workers foi chamado com auth_uid sintético
    const workerInsertCall = mockPool.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO workers'),
    );
    expect(workerInsertCall).toBeDefined();
    expect(workerInsertCall[1][0]).toBe('talentum_prof-1'); // auth_uid = talentum_<profileId>
    expect(workerInsertCall[1][1]).toBe('juan@test.com');   // email
  });

  // ─── 11. extractId com isSuccess=false ──────────────────────────────

  it('extractId retorna null quando isSuccess=false — e auto-cria worker', async () => {
    mockWorkerLookup.findByEmail.mockResolvedValue({
      isSuccess: false,
      getValue: () => ({ id: 'should-not-use' }),
    });
    mockWorkerLookup.findByPhone.mockResolvedValue({ getValue: () => null });

    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;

    const result = await useCase.execute(payload);
    // Email retornou isSuccess=false, phone retornou null → autoCreateWorker
    expect(result.workerId).toBe('w-auto');
  });

  // ─── 12. resolveJobPostingId retorna null em exceção ───────────────

  it('resolveJobPostingId retorna null quando lookup lança exceção', async () => {
    mockJobPostingLookup.findByTitleILike.mockRejectedValue(new Error('DB error'));

    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;

    const result = await useCase.execute(payload);
    // jobPostingId came from the mock prescreening repo passthrough (null from failed lookup)
    expect(result.jobPostingId).toBeNull();
  });

  // ─── 12.5. resolveJobPostingId extrai "CASO XXX" de nomes expandidos ──

  it('extrai "CASO XXX" de nome expandido do Talentum antes do lookup', async () => {
    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;
    payload.data.prescreening.name = 'CASO 182, AT, para pacientes con Depresión (F32) - Avellaneda';

    await useCase.execute(payload);

    expect(mockJobPostingLookup.findByTitleILike).toHaveBeenCalledWith('CASO 182');
  });

  it('usa nome original quando não contém padrão "CASO XXX"', async () => {
    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;
    payload.data.prescreening.name = 'Some Other Name';

    await useCase.execute(payload);

    expect(mockJobPostingLookup.findByTitleILike).toHaveBeenCalledWith('Some Other Name');
  });

  // ─── 13. upsertQuestions com responseType vazio ─────────────────────

  it('usa responseType vazio quando não informado', async () => {
    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;
    payload.data.profile.registerQuestions = [
      { questionId: 'q1', question: 'Test?', answer: 'Yes' }, // no responseType
    ];

    await useCase.execute(payload);

    expect(mockPrescreeningRepo.upsertQuestion).toHaveBeenCalledWith({
      questionId: 'q1',
      question: 'Test?',
      responseType: '', // defaults to ''
    });
  });

  // ─── 14. upsertQuestions com answer vazia ───────────────────────────

  it('passa null para answer vazia', async () => {
    const payload = buildPayload({ status: 'IN_PROGRESS' });
    (payload.data.response as any).statusLabel = undefined;
    payload.data.response.state = [
      { questionId: 'q2', question: 'Disponibilidade?', answer: '' }, // empty answer
    ];

    await useCase.execute(payload);

    expect(mockPrescreeningRepo.upsertResponse).toHaveBeenCalledWith(
      expect.objectContaining({ answer: null }),
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // Auto-criação de Worker (Step 1.5)
  // ═══════════════════════════════════════════════════════════════════

  describe('auto-criação de worker (Step 1.5)', () => {
    beforeEach(() => {
      // Nenhum lookup encontra o worker
      mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => null });
      mockWorkerLookup.findByPhone.mockResolvedValue({ getValue: () => null });
    });

    it('cria worker com auth_uid sintético e phone normalizado', async () => {
      const payload = buildPayload({ status: 'INITIATED', phoneNumber: '1151265663' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      const insertCall = mockPool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO workers'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][0]).toBe('talentum_prof-1');  // auth_uid
      expect(insertCall[1][1]).toBe('juan@test.com');    // email
      expect(insertCall[1][2]).toBe('5491151265663');    // phone normalizado (10 dígitos → 549...)
    });

    it('não auto-cria worker em dryRun', async () => {
      const payload = buildPayload({ status: 'INITIATED' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload, { dryRun: true });

      const insertCall = mockPool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO workers'),
      );
      expect(insertCall).toBeUndefined();
    });

    it('normalizePhoneAR retorna vazio → phone salvo como null', async () => {
      const payload = buildPayload({ status: 'INITIATED', phoneNumber: '' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      const insertCall = mockPool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO workers'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][2]).toBeNull(); // phone = null
    });

    it('recupera null quando 23505 mas nenhum row encontrado na SELECT de recovery', async () => {
      const uniqueError: any = new Error('duplicate key');
      uniqueError.code = '23505';

      mockPool.query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO workers')) return Promise.reject(uniqueError);
        if (sql.includes('SELECT id FROM workers')) return Promise.resolve({ rows: [] }); // no rows
        if (sql.includes('INSERT INTO encuadres')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });

      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      const result = await useCase.execute(payload);
      expect(result.workerId).toBeNull();
    });

    it('recupera worker existente em caso de unique constraint violation (email)', async () => {
      const uniqueError: any = new Error('duplicate key');
      uniqueError.code = '23505';

      mockPool.query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO workers')) return Promise.reject(uniqueError);
        if (sql.includes('SELECT id FROM workers')) {
          return Promise.resolve({ rows: [{ id: 'w-existing' }] });
        }
        if (sql.includes('INSERT INTO encuadres')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });

      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      const result = await useCase.execute(payload);
      expect(result.workerId).toBe('w-existing');
    });

    it('retorna null se auto-criação falha com erro não-constraint (não-fatal)', async () => {
      mockPool.query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO workers')) {
          return Promise.reject(new Error('connection timeout'));
        }
        if (sql.includes('INSERT INTO encuadres')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });

      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      // Não deve lançar — auto-criação é não-fatal
      const result = await useCase.execute(payload);
      expect(result.workerId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Auto-criação de Encuadre (Step 3.6)
  // ═══════════════════════════════════════════════════════════════════

  describe('auto-criação de encuadre (Step 3.6)', () => {
    it('cria encuadre com import_source_audit=Talentum e dedup_hash baseado no prescreeningId', async () => {
      const payload = buildPayload({ status: 'IN_PROGRESS', prescreeningId: 'tp-abc' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      const encuadreCall = mockPool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO encuadres'),
      );
      expect(encuadreCall).toBeDefined();
      // Params: [workerId, jobPostingId, workerName, phone, dedupHash]
      expect(encuadreCall[1][0]).toBe('w-1');                          // worker_id
      expect(encuadreCall[1][1]).toBe('jp-1');                         // job_posting_id
      expect(encuadreCall[1][2]).toBe('Juan Perez');                   // worker_raw_name
      expect(encuadreCall[1][4]).toMatch(/^[a-f0-9]{32}$/);           // dedup_hash (md5 hex)
    });

    it('não cria encuadre se workerId é null', async () => {
      mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => null });
      mockWorkerLookup.findByPhone.mockResolvedValue({ getValue: () => null });

      // Faz auto-criação do worker falhar
      mockPool.query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO workers')) return Promise.reject(new Error('fail'));
        if (sql.includes('INSERT INTO encuadres')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });

      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      const encuadreCall = mockPool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO encuadres'),
      );
      expect(encuadreCall).toBeUndefined();
    });

    it('não cria encuadre se jobPostingId é null', async () => {
      mockJobPostingLookup.findByTitleILike.mockResolvedValue(null);

      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      const encuadreCall = mockPool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO encuadres'),
      );
      expect(encuadreCall).toBeUndefined();
    });

    it('falha de encuadre é não-fatal (não lança erro)', async () => {
      mockPool.query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO encuadres')) return Promise.reject(new Error('DB error'));
        return Promise.resolve({ rows: [] });
      });

      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      // Não deve lançar
      await expect(useCase.execute(payload)).resolves.toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PII guard — achado do gate 11/09 (medido: 608 ocorrências/7d em prd)
  // ═══════════════════════════════════════════════════════════════════

  describe('PII guard — resolveWorker/ensureEncuadre nunca logam valor cru', () => {
    const SENSITIVE_EMAIL = 'candidata.sensivel@example.com';
    const SENSITIVE_PHONE = '+5491122334455';
    const SENSITIVE_CUIL = '20-12345678-9';

    it('resolveWorker: e-mail e telefone mascarados, CUIL fora do log por completo', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const payload = buildPayload({ email: SENSITIVE_EMAIL, phoneNumber: SENSITIVE_PHONE });
      (payload.data.profile as any).cuil = SENSITIVE_CUIL;

      await useCase.execute(payload);

      const lines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // O documento (CUIL) NUNCA aparece — nem cru, nem mascarado.
      expect(lines).not.toContain(SENSITIVE_CUIL);
      expect(lines).not.toContain('12345678');
      // E-mail/telefone crus nunca aparecem.
      expect(lines).not.toContain(SENSITIVE_EMAIL);
      expect(lines).not.toContain('1122334455');
      // Mas a linha existe, com os campos mascarados (prova que não sumiu o log inteiro).
      expect(lines).toContain('resolveWorker | email=');
      expect(lines).toMatch(/phone=\+549\*\*\*\*\*\*4455/);
      consoleSpy.mockRestore();
    });

    // Achado do gate (11/09, medido 608 ocorrências/7d em prd): o `phoneNumber`
    // do webhook Talentum chega CRU, sem formato garantido (schema só exige
    // string não-vazia — ver fixture ':641', que usa exatamente este valor sem
    // E.164). O único teste acima só cobre o caminho E.164 — é autoteste de um
    // lado só. Este cobre o caminho que a máscara por POSIÇÃO de caractere
    // (versão anterior a este fix) EXPUNHA MAIS: '1151265663' virava '1151**5663'
    // (8 de 10 dígitos visíveis).
    it('resolveWorker: telefone NÃO-E.164 (dígitos crus, como chega do Talentum) também mascarado, sem prefixo local exposto', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const NON_E164_PHONE = '1151265663';
      const payload = buildPayload({ phoneNumber: NON_E164_PHONE });

      await useCase.execute(payload);

      const lines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).toMatch(/phone=\*\*\*\*\*\*5663/);
      // O número cru inteiro, e qualquer prefixo local dele, nunca aparecem.
      expect(lines).not.toContain(NON_E164_PHONE);
      expect(lines).not.toContain('11512');
      consoleSpy.mockRestore();
    });

    it('ensureEncuadre: nome NUNCA aparece — só presença (hasName)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;
      // firstName/lastName fixos em 'Juan'/'Perez' via buildPayload — nome completo:
      const SENSITIVE_NAME = 'Juan Perez';

      await useCase.execute(payload);

      const lines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain(SENSITIVE_NAME);
      expect(lines).toMatch(/ensureEncuadre \| worker=.* \| job=.* \| hasName=true/);
      consoleSpy.mockRestore();
    });

    // Sabotagem: restaura em CÓPIA o `console.log` ANTIGO (interpolando o valor cru) —
    // prova que a asserção acima É capaz de detectar o vazamento, não é morta.
    it('sabotagem: reproduzindo o log ANTIGO, a asserção acima cairia', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const TAG = '[ProcessTalentumPrescreening]';

      // Comportamento ANTIGO (pré-fix): email/phone/cuil crus.
      console.log(`${TAG} resolveWorker | email=${SENSITIVE_EMAIL} | phone=${SENSITIVE_PHONE} | cuil=${SENSITIVE_CUIL}`);
      const oldLines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(oldLines).toContain(SENSITIVE_EMAIL); // confirma: o formato antigo VAZAVA
      expect(oldLines).toContain(SENSITIVE_CUIL);

      consoleSpy.mockRestore();
    });

    // Achado do gate, C3 do parecer do lex (2ª rodada): resolveJobPosting logava
    // o nome/título LIVRE do projeto no Talentum cru. Medido em prd (7d): 400/590
    // NÃO batem o formato exato "CASO N" — nunca se loga o texto livre.
    it('resolveJobPosting: nome livre do Talentum NUNCA aparece — só caseRef extraído ou <outro>', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const SENSITIVE_CASE_NAME = 'CASO 681 — Paciente com nome no título do projeto';
      const payload = buildPayload();
      (payload.data.prescreening as any).name = SENSITIVE_CASE_NAME;

      await useCase.execute(payload);

      const lines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain(SENSITIVE_CASE_NAME);
      expect(lines).not.toContain('Paciente com nome');
      expect(lines).toContain('resolveJobPosting | caseRef=CASO 681');
      consoleSpy.mockRestore();
    });

    it('resolveJobPosting: nome SEM padrão "CASO N" vira marcador fixo <outro>, nunca o texto livre', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const SENSITIVE_FREE_TEXT = 'Acompañante para Sra. Sensível — zona norte';
      const payload = buildPayload();
      (payload.data.prescreening as any).name = SENSITIVE_FREE_TEXT;

      await useCase.execute(payload);

      const lines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain(SENSITIVE_FREE_TEXT);
      expect(lines).not.toContain('Sensível');
      expect(lines).toContain('resolveJobPosting | caseRef=<outro>');
      consoleSpy.mockRestore();
    });

    // Sabotagem: reproduz o console.log ANTIGO (nome livre cru) — prova que a
    // asserção acima detectaria o vazamento se o fix fosse desfeito.
    it('sabotagem: reproduzindo o console.log ANTIGO (nome livre do Talentum cru), a asserção acima cairia', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const TAG = '[ProcessTalentumPrescreening]';
      const SENSITIVE_FREE_TEXT = 'Acompañante para Sra. Sensível — zona norte';
      console.log(`${TAG} resolveJobPosting | name="${SENSITIVE_FREE_TEXT}"`);
      const oldLines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(oldLines).toContain(SENSITIVE_FREE_TEXT); // confirma: o formato antigo vazava
      consoleSpy.mockRestore();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Progressão de status (INITIATED → IN_PROGRESS → COMPLETED → QUALIFIED)
  // ═══════════════════════════════════════════════════════════════════

  describe('progressão de application_funnel_stage', () => {
    it('INITIATED (Talentum subtype) → application_funnel_stage = PRE_SCREENING (migration 230: conversão interna)', async () => {
      // O Zod do webhook aceita 'INITIATED' como subtype — NÃO foi alterado.
      // deriveFunnelStage() converte internamente para PRE_SCREENING antes de gravar na WJA.
      const payload = buildPayload({ status: 'INITIATED' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'PRE_SCREENING' }),
        mockPoolClient,
      );
    });

    it('IN_PROGRESS → application_funnel_stage = IN_PROGRESS', async () => {
      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'IN_PROGRESS' }),
        mockPoolClient,
      );
    });

    it('COMPLETED → application_funnel_stage = COMPLETED', async () => {
      const payload = buildPayload({ status: 'COMPLETED' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'COMPLETED' }),
        mockPoolClient,
      );
    });

    it('ANALYZED + QUALIFIED → application_funnel_stage = QUALIFIED', async () => {
      const payload = buildPayload({ status: 'ANALYZED', statusLabel: 'QUALIFIED' });

      await useCase.execute(payload);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'QUALIFIED' }),
        mockPoolClient,
      );
    });

    it('ANALYZED + NOT_QUALIFIED → upsert WJA já com REJECTED (F3 pré-conversão) + auto-reject completa fluxo encuadre', async () => {
      const payload = buildPayload({ status: 'ANALYZED', statusLabel: 'NOT_QUALIFIED' });
      mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
        previousStage: null, // primeira vez → auto-reject ativo
      });

      await useCase.execute(payload);

      // F3 (migration 191): NOT_QUALIFIED foi removido do enum. ProcessTalentumPrescreening
      // converte NOT_QUALIFIED → REJECTED ANTES do upsert (senão CHECK constraint quebra).
      // handleNotQualifiedTransition continua rodando depois para encuadre RECHAZADO + domain events.
      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'REJECTED' }),
        mockPoolClient,
      );

      // Auto-reject: WJA imediatamente promovido para REJECTED na mesma transação
      const updateWjaCall = mockPoolClient.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE worker_job_applications') &&
          call[0].includes("'REJECTED'"),
      );
      expect(updateWjaCall).toBeDefined();

      // domain_event funnel_stage.rejected emitido
      const rejectedEventCall = mockPoolClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('funnel_stage.rejected'),
      );
      expect(rejectedEventCall).toBeDefined();
    });

    it('ANALYZED + IN_DOUBT → application_funnel_stage = IN_DOUBT', async () => {
      const payload = buildPayload({ status: 'ANALYZED', statusLabel: 'IN_DOUBT' });

      await useCase.execute(payload);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'IN_DOUBT' }),
        mockPoolClient,
      );
    });

    it('ANALYZED + QUALIFIED persiste status QUALIFIED (não ANALYZED) no prescreening', async () => {
      const payload = buildPayload({ status: 'ANALYZED', statusLabel: 'QUALIFIED' });

      await useCase.execute(payload);

      expect(mockPrescreeningRepo.upsertPrescreening).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'QUALIFIED' }),
      );
    });

    it('ANALYZED sem statusLabel → NÃO faz upsert (ANALYZED não é valor válido)', async () => {
      const payload = buildPayload({ status: 'ANALYZED' });
      (payload.data.response as any).statusLabel = undefined;

      await useCase.execute(payload);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).not.toHaveBeenCalled();
    });

    it('cada webhook atualiza o stage — simula fluxo completo INITIATED → QUALIFIED', async () => {
      // Webhook 1: INITIATED (Talentum subtype) → PRE_SCREENING (canônico interno, migration 230)
      const p1 = buildPayload({ status: 'INITIATED' });
      (p1.data.response as any).statusLabel = undefined;
      await useCase.execute(p1);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenLastCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'PRE_SCREENING' }),
        mockPoolClient,
      );

      // Webhook 2: IN_PROGRESS
      const p2 = buildPayload({ status: 'IN_PROGRESS' });
      (p2.data.response as any).statusLabel = undefined;
      await useCase.execute(p2);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenLastCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'IN_PROGRESS' }),
        mockPoolClient,
      );

      // Webhook 3: COMPLETED
      const p3 = buildPayload({ status: 'COMPLETED' });
      (p3.data.response as any).statusLabel = undefined;
      await useCase.execute(p3);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenLastCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'COMPLETED' }),
        mockPoolClient,
      );

      // Webhook 4: ANALYZED + QUALIFIED
      mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mockResolvedValue({
        previousStage: 'COMPLETED',
      });
      const p4 = buildPayload({ status: 'ANALYZED', statusLabel: 'QUALIFIED' });
      await useCase.execute(p4);

      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenLastCalledWith(
        expect.objectContaining({ applicationFunnelStage: 'QUALIFIED' }),
        mockPoolClient,
      );

      // Total: 4 upserts em worker_job_applications
      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledTimes(4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Fluxo completo: worker não existe → auto-criar → encuadre → funnel
  // ═══════════════════════════════════════════════════════════════════

  describe('fluxo completo para worker novo', () => {
    it('auto-cria worker, cria encuadre e atualiza funnel stage', async () => {
      // Worker não existe em nenhum lookup
      mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => null });
      mockWorkerLookup.findByPhone.mockResolvedValue({ getValue: () => null });

      const payload = buildPayload({ status: 'IN_PROGRESS' });
      (payload.data.response as any).statusLabel = undefined;

      const result = await useCase.execute(payload);

      // 1. Worker auto-criado
      expect(result.workerId).toBe('w-auto');

      // 2. Prescreening upsertado com workerId do auto-criado
      expect(mockPrescreeningRepo.upsertPrescreening).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'w-auto' }),
      );

      // 3. worker_job_applications atualizado com IN_PROGRESS
      expect(mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: 'w-auto',
          applicationFunnelStage: 'IN_PROGRESS',
        }),
        mockPoolClient,
      );

      // 4. Encuadre criado
      const encuadreCall = mockPool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO encuadres'),
      );
      expect(encuadreCall).toBeDefined();
      expect(encuadreCall[1][0]).toBe('w-auto'); // worker_id
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // effectiveStatus — cobertura de todos os valores possíveis
  // Garante que o mapeamento nunca produz um valor fora do tipo
  // TalentumPrescreeningStatus (prevenção do bug CHECK constraint).
  // ═══════════════════════════════════════════════════════════════════

  describe('effectiveStatus — cobertura de todos os valores possíveis', () => {
    const VALID_DB_STATUSES: TalentumPrescreeningStatus[] = [
      'INITIATED', 'IN_PROGRESS', 'COMPLETED', 'ANALYZED',
      'QUALIFIED', 'NOT_QUALIFIED', 'IN_DOUBT', 'PENDING',
    ];

    // subtypes que mapeiam diretamente para status (sem statusLabel)
    it.each(['INITIATED', 'IN_PROGRESS', 'COMPLETED'] as const)(
      'subtype=%s (sem statusLabel) → upsertPrescreening recebe status=%s (valor válido)',
      async (subtype) => {
        const payload = buildPayload({ status: subtype });
        (payload.data.response as any).statusLabel = undefined;

        await useCase.execute(payload);

        const call = mockPrescreeningRepo.upsertPrescreening.mock.calls[0][0];
        expect(call.status).toBe(subtype);
        expect(VALID_DB_STATUSES).toContain(call.status);
      },
    );

    // ANALYZED + statusLabel → usa statusLabel como effectiveStatus
    it.each(['QUALIFIED', 'NOT_QUALIFIED', 'IN_DOUBT'] as const)(
      'ANALYZED + statusLabel=%s → upsertPrescreening recebe status=%s (valor válido)',
      async (statusLabel) => {
        const payload = buildPayload({ status: 'ANALYZED', statusLabel });

        await useCase.execute(payload);

        const call = mockPrescreeningRepo.upsertPrescreening.mock.calls[0][0];
        expect(call.status).toBe(statusLabel);
        expect(VALID_DB_STATUSES).toContain(call.status);
      },
    );

    // Caso especial: ANALYZED + PENDING → persiste PENDING (statusLabel vence, não subtype)
    it('ANALYZED + statusLabel=PENDING → upsertPrescreening recebe status=PENDING (não ANALYZED)', async () => {
      const payload = buildPayload({ status: 'ANALYZED', statusLabel: 'PENDING' });

      await useCase.execute(payload);

      const call = mockPrescreeningRepo.upsertPrescreening.mock.calls[0][0];
      expect(call.status).toBe('PENDING');
      expect(call.status).not.toBe('ANALYZED');
      expect(VALID_DB_STATUSES).toContain(call.status);
    });
  });

  // ─── Resolução ciente de merge (caso Norma Araujo, 13/08) ──────────
  //
  // O lookup por e-mail/telefone/CUIL devolve a linha crua de `workers`,
  // inclusive uma já fundida em outra. Escrever nela cria uma segunda
  // postulação da MESMA pessoa na mesma vaga — a UNIQUE (worker_id,
  // job_posting_id) não pega, porque os IDs são diferentes.

  describe('resolução ciente de merge', () => {
    /**
     * Faz a cadeia `from` → `to` (1 salto) na query recursiva, no shape que
     * `resolveCanonicalWorkerId` lê: a linha mais profunda da corrente.
     * `to = null` = corrente que não termina em worker vivo (ciclo) — a linha
     * mais profunda ainda tem `merged_into_id` preenchido.
     */
    function mockMergeChain(from: string, to: string | null) {
      mockPool.query.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('WITH RECURSIVE chain')) {
          const id = params?.[0];
          if (id === from) {
            return Promise.resolve({
              rows: to
                ? [{ id: to, depth: 1, merged_into_id: null }]
                : [{ id: from, depth: 10, merged_into_id: 'w-loop' }],
            });
          }
          return Promise.resolve({ rows: [{ id, depth: 0, merged_into_id: null }] });
        }
        if (sql.includes('INSERT INTO workers')) return Promise.resolve({ rows: [{ id: 'w-auto' }] });
        if (sql.includes('SELECT id FROM workers')) return Promise.resolve({ rows: [{ id: 'w-dead' }] });
        return Promise.resolve({ rows: [] });
      });
    }

    it('lookup devolveu registro fundido → escreve a postulação no SOBREVIVENTE', async () => {
      mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => ({ id: 'w-dead' }) } as never);
      mockMergeChain('w-dead', 'w-alive');

      await useCase.execute(buildPayload({ statusLabel: 'QUALIFIED' }));

      const wja = mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mock.calls[0][0];
      expect(wja.workerId).toBe('w-alive');
      expect(wja.workerId).not.toBe('w-dead');
    });

    it('worker vivo segue intocado (sem regressão no caminho normal)', async () => {
      mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => ({ id: 'w-alive' }) } as never);
      mockMergeChain('w-alive', 'w-alive');

      await useCase.execute(buildPayload({ statusLabel: 'QUALIFIED' }));

      const wja = mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mock.calls[0][0];
      expect(wja.workerId).toBe('w-alive');
    });

    it('cadeia quebrada (ciclo) → mantém o ID cru, NUNCA auto-cria outro cadastro', async () => {
      // Devolver null aqui faria o fluxo auto-criar um worker novo — mais uma
      // duplicata da mesma pessoa, pior que o bug original.
      mockWorkerLookup.findByEmail.mockResolvedValue({ getValue: () => ({ id: 'w-dead' }) } as never);
      mockMergeChain('w-dead', null);

      await useCase.execute(buildPayload({ statusLabel: 'QUALIFIED' }));

      const wja = mockPrescreeningRepo.upsertWorkerJobApplicationFromTalentum.mock.calls[0][0];
      expect(wja.workerId).toBe('w-dead');
      expect(
        mockPool.query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO workers')),
      ).toBe(false);
      // Escrever num cadastro possivelmente morto é exceção: precisa de alarme
      // de verdade (reportError → Cloud Error Reporting), não console.error.
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('cadeia de merge não resolveu') }),
        expect.objectContaining({ source: 'ProcessTalentumPrescreening:toCanonical' }),
      );
    });
  });
});
