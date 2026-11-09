/**
 * worker-deduplication.test.ts
 *
 * Testes RIGOROSOS com pegadinhas para WorkerDeduplicationService.
 *
 * Cobertos:
 *   parseLLMResponse   → coerção de tipos, clamping, valores inválidos
 *   runDeduplicationForWorkers → boundary de confiança, dryRun, erros isolados
 *   mergeWorkers       → atomicidade da transação, ROLLBACK, release garantido
 *   chooseCanonical    → fallback, ordenação
 *   analyzeWithLLM     → erros HTTP, choices vazio, parsing
 */

// ─── MOCKS ANTES DE QUALQUER IMPORT ────────────────────────────────────────

jest.mock('@shared/database/DatabaseConnection');
jest.mock('../../repositories/AnalyticsRepository');
jest.mock('@shared/security/KMSEncryptionService');

import { WorkerDeduplicationService } from '../WorkerDeduplicationService';
import { AnalyticsRepository, DuplicateCandidate } from '../../repositories/AnalyticsRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Candidato mínimo válido para testes */
function makePair(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    worker1Id:        'w1-id',
    worker1Phone:     '5491151265663',
    worker1Email:     'w1@enlite.import',
    worker1FirstName: 'García',
    worker1LastName:  'María',
    worker1Cuit:      null,
    worker1Sources:   ['planilla_operativa'],
    worker2Id:        'w2-id',
    worker2Phone:     '5491151265660',
    worker2Email:     'garcia@gmail.com',
    worker2FirstName: 'García',
    worker2LastName:  'María',
    worker2Cuit:      null,
    worker2Sources:   ['talent_search'],
    matchReason:      'phone_similar',
    ...overrides,
  };
}

/** Resposta LLM que confirma duplicata com alta confiança */
function llmYes(overrides: Record<string, unknown> = {}) {
  return {
    is_same_person:       true,
    confidence:           0.92,
    explanation:          'Mesma pessoa.',
    preferred_phone:      2,
    preferred_email:      2,
    preferred_first_name: 1,
    preferred_last_name:  1,
    preferred_cuit:       null,
    merged_phone:         '5491151265663',
    merged_email:         'garcia@gmail.com',
    merged_first_name:    'García',
    merged_last_name:     'María',
    merged_cuit:          null,
    ...overrides,
  };
}

function mockFetchOk(body: object) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok:   true,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

// ─── Configuração de mocks ──────────────────────────────────────────────────

let mockPool: jest.Mocked<any>;
let mockClient: jest.Mocked<any>;
let mockAnalyticsRepo: jest.Mocked<any>;
let service: WorkerDeduplicationService;

beforeEach(() => {
  jest.clearAllMocks();

  mockClient = {
    query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };

  mockPool = {
    query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue(mockClient),
  };

  mockAnalyticsRepo = {
    findDuplicateCandidatesForWorkers: jest.fn().mockResolvedValue([]),
    findDuplicateCandidates:           jest.fn().mockResolvedValue([]),
  };

  (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({ getPool: () => mockPool });
  (AnalyticsRepository as jest.Mock).mockImplementation(() => mockAnalyticsRepo);

  // Mock KMSEncryptionService para retornar valores mockados
  (KMSEncryptionService as jest.Mock).mockImplementation(() => ({
    encrypt: jest.fn().mockImplementation((value: string) => Promise.resolve(`encrypted_${value}`)),
    decrypt: jest.fn().mockImplementation((value: string) => Promise.resolve(value.replace('encrypted_', ''))),
    encryptBatch: jest.fn().mockImplementation((fields: Record<string, string | null>) => {
      const encrypted: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(fields)) {
        encrypted[key] = value ? `encrypted_${value}` : null;
      }
      return Promise.resolve(encrypted);
    }),
  }));

  // GROQ key presente por padrão
  process.env.GROQ_API_KEY = 'test-key-abc123';
  global.fetch = jest.fn();

  service = new WorkerDeduplicationService();
});

afterEach(() => {
  delete process.env.GROQ_API_KEY;
});

// ═══════════════════════════════════════════════════════════════════
//  parseLLMResponse — coerção de tipos e clamping
// ═══════════════════════════════════════════════════════════════════

describe('parseLLMResponse — coerção e validação', () => {
  const parse = (raw: object) => (service as any).parseLLMResponse(raw);

  // ── P1 — confidence > 1 → clampado para 1.0 ────────────────────────────
  it('P1 — confidence = 1.5 é clampado para 1.0', () => {
    expect(parse({ confidence: 1.5 }).confidence).toBe(1);
  });

  // ── P2 — confidence < 0 → clampado para 0.0 ────────────────────────────
  it('P2 — confidence = -0.5 é clampado para 0.0', () => {
    expect(parse({ confidence: -0.5 }).confidence).toBe(0);
  });

  // ── P3 — pegadinha: is_same_person como STRING "true" → false ───────────
  it('P3 — is_same_person = "true" (string, não boolean) → isSamePerson = false', () => {
    // O campo EXIGE typeof === 'boolean'. "true" !== true.
    expect(parse({ is_same_person: 'true' }).isSamePerson).toBe(false);
  });

  // ── P4 — pegadinha: preferred_phone = 3 → null (só 1 ou 2 são válidos) ─
  it('P4 — preferred_phone = 3 → null (fora do range 1|2)', () => {
    expect(parse({ preferred_phone: 3 }).preferredPhone).toBeNull();
  });

  // ── P5 — pegadinha: preferred_phone = 0 → null ──────────────────────────
  it('P5 — preferred_phone = 0 → null', () => {
    expect(parse({ preferred_phone: 0 }).preferredPhone).toBeNull();
  });

  // ── P6 — pegadinha: preferred_phone = "1" (string) → null ───────────────
  it('P6 — preferred_phone = "1" (string) → null (não está em [1, 2])', () => {
    // [1,2].includes("1") = false porque é string, não number
    expect(parse({ preferred_phone: '1' }).preferredPhone).toBeNull();
  });

  // ── P7 — merged_email = null → string vazia (nunca null) ────────────────
  it('P7 — merged_email = null → "" (nunca retorna null para email)', () => {
    expect(parse({ merged_email: null }).mergedEmail).toBe('');
  });

  // ── P8 — objeto vazio → todos os defaults seguros ───────────────────────
  it('P8 — objeto vazio {} → todos os campos com defaults seguros', () => {
    const result = parse({});
    expect(result.isSamePerson).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.explanation).toBe('');
    expect(result.preferredPhone).toBeNull();
    expect(result.mergedEmail).toBe('');
    expect(result.mergedPhone).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  runDeduplicationForWorkers — pipeline e boundary de confiança
// ═══════════════════════════════════════════════════════════════════

describe('runDeduplicationForWorkers — pipeline e pegadinhas', () => {

  // ── R1 — array vazio → retorna cedo SEM consultar o banco ───────────────
  it('R1 — IDs vazio → retorna empty report sem chamar AnalyticsRepository', async () => {
    const report = await service.runDeduplicationForWorkers([]);
    expect(report.candidatesFound).toBe(0);
    expect(report.analyzed).toBe(0);
    expect(mockAnalyticsRepo.findDuplicateCandidatesForWorkers).not.toHaveBeenCalled();
  });

  // ── R2 — sem GROQ key → lança erro imediatamente ────────────────────────
  it('R2 — GROQ_API_KEY ausente → lança erro antes de qualquer query', async () => {
    delete process.env.GROQ_API_KEY;
    const fresh = new WorkerDeduplicationService();
    await expect(fresh.runDeduplicationForWorkers(['w1'])).rejects.toThrow('GROQ_API_KEY');
    expect(mockAnalyticsRepo.findDuplicateCandidatesForWorkers).not.toHaveBeenCalled();
  });

  // ── R3 — zero candidatos → sem LLM calls, sem merges ────────────────────
  it('R3 — zero candidatos encontrados → analyzed=0, nenhuma chamada ao LLM', async () => {
    mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mockResolvedValue([]);
    const report = await service.runDeduplicationForWorkers(['w1', 'w2']);
    expect(report.candidatesFound).toBe(0);
    expect(report.analyzed).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── R4 — LLM diz isSamePerson=false → mergesSkipped++, merge NÃO ocorre ─
  it('R4 — LLM diz is_same_person=false → mergesSkipped++, mergeWorkers NÃO chamado', async () => {
    mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mockResolvedValue([makePair()]);
    mockFetchOk({ choices: [{ message: { content: JSON.stringify(llmYes({ is_same_person: false, confidence: 0.99 })) } }] });
    const spy = jest.spyOn(service, 'mergeWorkers');

    const report = await service.runDeduplicationForWorkers(['w1-id', 'w2-id']);
    expect(report.mergesSkipped).toBe(1);
    expect(report.mergesExecuted).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  // ── R5 — PEGADINHA: confidence = 0.84 (abaixo) → NÃO mescla ────────────
  it('R5 — confidence = 0.84 (< 0.85) → não mescla (mergesSkipped)', async () => {
    mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mockResolvedValue([makePair()]);
    mockFetchOk({ choices: [{ message: { content: JSON.stringify(llmYes({ confidence: 0.84 })) } }] });
    mockPool.query.mockResolvedValue({ rows: [{ id: 'w1-id' }], rowCount: 1 });
    const spy = jest.spyOn(service, 'mergeWorkers');

    const report = await service.runDeduplicationForWorkers(['w1-id', 'w2-id']);
    expect(report.mergesSkipped).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  // ── R6 — PEGADINHA: confidence = 0.85 (EXATAMENTE no threshold) → mescla
  it('R6 — confidence = 0.85 (exatamente no threshold) → MESCLA (>= não >)', async () => {
    mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mockResolvedValue([makePair()]);
    mockFetchOk({ choices: [{ message: { content: JSON.stringify(llmYes({ confidence: 0.85 })) } }] });
    // chooseCanonical retorna w1-id
    mockPool.query.mockResolvedValue({ rows: [{ id: 'w1-id' }], rowCount: 1 });
    jest.spyOn(service, 'mergeWorkers').mockResolvedValue(undefined);

    const report = await service.runDeduplicationForWorkers(['w1-id', 'w2-id']);
    expect(report.mergesExecuted).toBe(1);
  });

  // ── R7 — PEGADINHA: dryRun=true + isSame=true + confidence=0.99 → NÃO mescla
  it('R7 — dryRun=true: mesmo isSame=true e confidence=0.99, mergeWorkers NÃO é chamado', async () => {
    mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mockResolvedValue([makePair()]);
    mockFetchOk({ choices: [{ message: { content: JSON.stringify(llmYes({ confidence: 0.99 })) } }] });
    const spy = jest.spyOn(service, 'mergeWorkers');

    const report = await service.runDeduplicationForWorkers(['w1-id'], { dryRun: true });
    expect(spy).not.toHaveBeenCalled();
    expect(report.mergesSkipped).toBe(1);
    expect(report.mergesExecuted).toBe(0);
  });

  // ── R8 — erro em 1 candidato → errors++, outros candidatos processados ──
  it('R8 — erro no LLM de 1 candidato → errors++, 2º candidato ainda processado', async () => {
    const pair1 = makePair({ worker1Id: 'wA', worker2Id: 'wB' });
    const pair2 = makePair({ worker1Id: 'wC', worker2Id: 'wD', matchReason: 'cuit_match' });
    mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mockResolvedValue([pair1, pair2]);

    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok:   true,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(llmYes()) } }] }),
        text: () => Promise.resolve(''),
      });

    mockPool.query.mockResolvedValue({ rows: [{ id: 'wC' }], rowCount: 1 });
    jest.spyOn(service, 'mergeWorkers').mockResolvedValue(undefined);

    const report = await service.runDeduplicationForWorkers(['wA','wB','wC','wD']);
    expect(report.errors).toBe(1);
    expect(report.analyzed).toBe(1);   // só o 2º foi analisado com sucesso
    expect(report.details[0].error).toMatch('Network error');
    expect(report.details[1].error).toBeNull();
  });

  // ── R9 — PEGADINHA: IDs duplicados no input → Set deduplication ─────────
  it('R9 — IDs duplicados no input ["w1","w1","w2"] → Set: repo chamado com ["w1","w2"]', async () => {
    mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mockResolvedValue([]);
    await service.runDeduplicationForWorkers(['w1', 'w1', 'w2', 'w2', 'w1']);
    const calledWith = mockAnalyticsRepo.findDuplicateCandidatesForWorkers.mock.calls[0][0];
    // Sem duplicatas
    expect(new Set(calledWith).size).toBe(calledWith.length);
    expect(calledWith.sort()).toEqual(['w1', 'w2']);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  mergeWorkers — atomicidade e pegadinhas de transação
// ═══════════════════════════════════════════════════════════════════

describe('mergeWorkers — transação atômica', () => {
  const resolved = {
    phone: '5491151265663', email: 'garcia@gmail.com',
    firstName: 'García', lastName: 'María', cuit: null,
  };

  // ── M1 — happy path: BEGIN → queries → COMMIT ───────────────────────────
  it('M1 — happy path: BEGIN e COMMIT chamados, todas as queries executadas', async () => {
    await service.mergeWorkers('canonical-id', 'duplicate-id', resolved);

    const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 3]).toMatch(/merged_into_id/);  // step 8
    expect(calls[calls.length - 2]).toMatch(/iam\.merge_person/); // gancho da pessoa (T130)
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  // ── M2 — PEGADINHA: erro no UPDATE canonical → ROLLBACK, erro relançado ─
  it('M2 — erro no UPDATE do canonical → ROLLBACK é chamado, erro é relançado', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)           // BEGIN ok
      .mockRejectedValueOnce(new Error('DB constraint violation')); // UPDATE fail

    await expect(service.mergeWorkers('c', 'd', resolved)).rejects.toThrow('DB constraint violation');

    const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  // ── M3 — PEGADINHA: erro na relinkagem de encuadres → ROLLBACK ──────────
  it('M3 — erro no UPDATE encuadres → ROLLBACK chamado', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)                         // BEGIN
      .mockResolvedValueOnce(undefined)                         // UPDATE workers (canonical)
      .mockRejectedValueOnce(new Error('encuadres lock timeout')); // UPDATE encuadres

    await expect(service.mergeWorkers('c', 'd', resolved)).rejects.toThrow('encuadres lock timeout');

    const calls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('ROLLBACK');
  });

  // ── M4 — client.release() chamado mesmo em caso de erro ─────────────────
  it('M4 — client.release() é chamado no finally mesmo quando ocorre erro', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('crash'));

    await expect(service.mergeWorkers('c', 'd', resolved)).rejects.toThrow();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  // ── M5 — merged_into_id do duplicado aponta para o canônico ─────────────
  it('M5 — UPDATE final: merged_into_id = canonicalId WHERE id = duplicateId', async () => {
    await service.mergeWorkers('canonical-123', 'duplicate-456', resolved);

    const mergeQuery = mockClient.query.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('merged_into_id'),
    );
    expect(mergeQuery).toBeDefined();
    expect(mergeQuery[1]).toEqual(['canonical-123', 'duplicate-456']);
  });

  // ── M6 — worker_job_applications: INSERT + DELETE ambos chamados ─────────
  it('M6 — worker_job_applications: INSERT ON CONFLICT DO NOTHING e DELETE executados', async () => {
    await service.mergeWorkers('c', 'd', resolved);

    const queries = mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
    const hasInsertApps = queries.some((q: string) => q.includes('worker_job_applications') && q.includes('INSERT'));
    const hasDeleteApps = queries.some((q: string) => q.includes('worker_job_applications') && q.includes('DELETE'));
    expect(hasInsertApps).toBe(true);
    expect(hasDeleteApps).toBe(true);
  });

  // ── M7 — blacklist: INSERT + DELETE ambos chamados ──────────────────────
  it('M7 — blacklist: INSERT ON CONFLICT DO NOTHING e DELETE executados', async () => {
    await service.mergeWorkers('c', 'd', resolved);

    const queries = mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
    const hasInsertBl  = queries.some((q: string) => q.includes('blacklist') && q.includes('INSERT'));
    const hasDeleteBl  = queries.some((q: string) => q.includes('blacklist') && q.includes('DELETE'));
    expect(hasInsertBl).toBe(true);
    expect(hasDeleteBl).toBe(true);
  });

  // ── M8 — PEGADINHA: resolved.phone = null → COALESCE preserva existente ─
  it('M8 — phone = null em resolvedData → COALESCE mantém o phone existente no banco', async () => {
    await service.mergeWorkers('c', 'd', { ...resolved, phone: null });

    // O 1º UPDATE (canonical) recebe null como $2 → COALESCE(null, phone) = phone existente
    const updateCall = mockClient.query.mock.calls[1]; // index 0 = BEGIN, index 1 = UPDATE
    expect(updateCall[1][1]).toBeNull(); // $2 = phone = null
    // A query usa COALESCE, então phone existente é preservado (comportamento correto)
  });
});

// ═══════════════════════════════════════════════════════════════════
//  chooseCanonical — seleção do worker canônico
// ═══════════════════════════════════════════════════════════════════

describe('chooseCanonical — seleção do canônico', () => {
  const choose = (id1: string, id2: string) =>
    (service as any).chooseCanonical(id1, id2);

  // ── CC1 — retorna o id do 1º resultado da query ──────────────────────────
  it('CC1 — retorna o ID do 1º row (melhor candidato por first_name preenchido DESC, created_at ASC)', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: 'wA' }], rowCount: 1 });
    const result = await choose('wA', 'wB');
    expect(result).toBe('wA');
  });

  // ── CC2 — PEGADINHA: DB retorna 0 rows → fallback para id1 ──────────────
  it('CC2 — DB retorna 0 rows (workers não encontrados) → fallback seguro para id1', async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await choose('id1-fallback', 'id2');
    expect(result).toBe('id1-fallback');
  });

  // ── CC3 — query inclui ORDER BY first_name_encrypted IS NOT NULL DESC ─────────────
  it('CC3 — query ordena por first_name preenchido DESC para preferir o mais completo', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: 'id1' }] });
    await choose('id1', 'id2');

    const sql = String(mockPool.query.mock.calls[0][0]);
    expect(sql).toMatch(/first_name_encrypted.*IS NOT NULL/i);
    expect(sql).toMatch(/created_at.*ASC/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  analyzeWithLLM — erros HTTP e parsing
// ═══════════════════════════════════════════════════════════════════

describe('analyzeWithLLM — erros e parsing', () => {

  // ── AL1 — resposta 401 → lança erro com status ──────────────────────────
  it('AL1 — API retorna 401 → lança "Groq API error 401"', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok:   false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    await expect(service.analyzeWithLLM(makePair())).rejects.toThrow('401');
  });

  // ── AL2 — choices array vazio → lança "Resposta vazia" ──────────────────
  it('AL2 — choices array vazio → lança erro "Resposta vazia"', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({ choices: [] }),
    });
    await expect(service.analyzeWithLLM(makePair())).rejects.toThrow('Resposta vazia');
  });

  // ── AL3 — resposta JSON válida → retorna DuplicateAnalysis corretamente ──
  it('AL3 — resposta válida → isSamePerson e mergedPhone mapeados corretamente', async () => {
    const body = { choices: [{ message: { content: JSON.stringify(llmYes()) } }] };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve(body),
    });
    const result = await service.analyzeWithLLM(makePair());
    expect(result.isSamePerson).toBe(true);
    expect(result.confidence).toBe(0.92);
    expect(result.mergedPhone).toBe('5491151265663');
    expect(result.mergedEmail).toBe('garcia@gmail.com');
  });

  // ── AL4 — PEGADINHA: confidence = 1.5 na resposta → clampado para 1.0 ───
  it('AL4 — confidence = 1.5 vinda da API → clampado para 1.0 pelo parseLLMResponse', async () => {
    const body = { choices: [{ message: { content: JSON.stringify(llmYes({ confidence: 1.5 })) } }] };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve(body),
    });
    const result = await service.analyzeWithLLM(makePair());
    expect(result.confidence).toBe(1.0);   // NÃO 1.5
  });

  // ── AL5 — prompt inclui regras de telefone argentino ────────────────────
  it('AL5 — prompt enviado ao Groq menciona a regra de 10→13 dígitos argentinos', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(llmYes()) } }] }),
    });
    await service.analyzeWithLLM(makePair());

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === 'user').content;
    // Verifica que a regra de telefone argentino está no prompt
    expect(userMsg).toMatch(/10.*dígitos.*549|549.*13.*dígitos/i);
  });
});
