/**
 * ActivatePatientUseCase — Fase 2 Task 3 (plano-app-pacientes §6, decisão D5).
 *
 * Covers:
 *   c. activate creates ONE draft vacancy per active address and sets ACTIVE,
 *      all in one transaction (COMMIT once, no ROLLBACK).
 *   d. activate with 0 active addresses → NoActiveAddressError, nothing created
 *      (no INSERT, no status UPDATE), transaction rolled back.
 *   e. activate on an already-ACTIVE patient → idempotent no-op (alreadyActive,
 *      no INSERT, no status UPDATE — never duplicates vacancies).
 *   f. missing patient → PatientNotFoundError.
 */

// ── Mocks (before imports) ────────────────────────────────────────────────────

const mockClient = { query: jest.fn(), release: jest.fn() };
const mockConnect = jest.fn().mockResolvedValue(mockClient);

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn(() => ({
      getPool: jest.fn(() => ({ connect: mockConnect })),
    })),
  },
}));

// Reuse of the vacancy INSERT is proven by the controller/integration layers;
// here we stub it to keep the unit test focused on the activation orchestration.
const mockBuildInsertParams = jest.fn((p: Record<string, unknown>) => [
  p.vacancyNumber,
  p.case_number,
  p.patient_id,
  p.patient_address_id,
]);
jest.mock('@modules/matching', () => ({
  buildInsertQuery: jest.fn(() => 'INSERT INTO job_postings (...) VALUES (...) RETURNING *'),
  buildInsertParams: (p: Record<string, unknown>) => mockBuildInsertParams(p),
}));

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  ActivatePatientUseCase,
  PatientNotFoundError,
  PatientNotReadyError,
  NoActiveAddressError,
} from '../ActivatePatientUseCase';
import { computePatientCompleteness } from '../../domain/PatientCompleteness';
import * as PatientCompletenessModule from '../../domain/PatientCompleteness';

// ── Query dispatcher ──────────────────────────────────────────────────────────

interface DispatchOpts {
  patientRow?: {
    id: string;
    status: string;
    case_number: number | null;
    /** Spec 014 (SUP-D1): omitido = paciente MAIOR, com consentimento e cobertura informada —
     * "pronto" nos 3 critérios que o gate exige, para os testes pré-existentes (que testam
     * ENDEREÇO/serviço/status, não completude) não precisarem repetir os 3 campos. */
    birth_date?: string | null;
    has_consent?: boolean | null;
    insurance_informed?: string | null;
  } | null;
  addressIds?: string[];
  /** Spec 013 bloco C: `patient_contracted_services` ATIVOS deste paciente (a query já filtra
   * `WHERE active` — um serviço inativo simplesmente não aparece aqui, o mesmo shape de "zero
   * serviços declarados"). Omitido = comportamento pré-existente (fallback, sem serviço).
   * `provider_age_band` (spec 015, US-A6.2) omitido = undefined, mesmo tratamento de null
   * (vacancyRangeForProviderAgeBand). */
  activeServices?: Array<{
    id: string;
    providers_needed: number | null;
    provider_age_band?: string | null;
    /** Migration 330: endereço VIVO do serviço (LEFT JOIN em patient_addresses não arquivado).
     * Omitido = null = "sem endereço" → SERVICE_ADDRESS bloqueia. */
    live_address_id?: string | null;
    /** Migration 330: horário do encuadre, copiado tal qual para a vaga. Omitido = null. */
    schedule?: unknown;
  }>;
  /** Spec 014: `patient_responsibles` deste paciente (só importa quando `birth_date` é menor). */
  responsibleCount?: number;
}

function programClient(opts: DispatchOpts): { seen: string[] } {
  const seen: string[] = [];
  let nextvalIdx = 0;
  let insertIdx = 0;

  mockClient.query.mockImplementation(async (sql: string) => {
    seen.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
      if (!opts.patientRow) return { rowCount: 0, rows: [] };
      // `?? default` trataria `null` explícito (ex.: "sem cobertura") IGUAL a "não passei o
      // campo" — usa `in` para distinguir "ausente → padrão pronto" de "presente e null → o
      // teste QUER esse critério faltando".
      const row = {
        ...opts.patientRow,
        birth_date: 'birth_date' in opts.patientRow ? opts.patientRow.birth_date : null,
        has_consent: 'has_consent' in opts.patientRow ? opts.patientRow.has_consent : true,
        insurance_informed:
          'insurance_informed' in opts.patientRow ? opts.patientRow.insurance_informed : 'OSDE',
      };
      return { rowCount: 1, rows: [row] };
    }
    if (sql.includes('FROM patient_addresses')) {
      const rows = (opts.addressIds ?? []).map((id) => ({ id }));
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('FROM patient_contracted_services')) {
      const rows = (opts.activeServices ?? []).map((svc) => ({
        ...svc,
        live_address_id: svc.live_address_id ?? null,
        schedule: svc.schedule ?? null,
      }));
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('FROM patient_responsibles')) {
      return { rowCount: 1, rows: [{ count: opts.responsibleCount ?? 0 }] };
    }
    if (sql.includes('nextval')) {
      return { rows: [{ vn: String(100 + nextvalIdx++) }] };
    }
    if (sql.includes('INSERT INTO job_postings')) {
      return { rows: [{ id: `vac-${++insertIdx}` }] };
    }
    if (sql.includes('UPDATE patients SET status')) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });

  return { seen };
}

/**
 * Horário mínimo válido para as fixtures. Desde a decisão do Gabriel 07/09, serviço ativo SEM
 * horário BLOQUEIA a ativação (SERVICE_SCHEDULE) — então todo teste que mede OUTRA coisa (franja,
 * LEFT JOIN de endereço, contagem de vagas) precisa dar horário aos seus serviços, senão falharia
 * por um motivo que não é o que ele verifica. A recusa por falta de horário tem teste próprio (l4).
 */
const HORARIO_OK = [{ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' }];

const countSql = (seen: string[], needle: string): number =>
  seen.filter((s) => s.includes(needle)).length;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActivatePatientUseCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(mockClient);
  });

  it('c. creates ONE draft vacancy per active address and sets ACTIVE (single transaction)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-1', status: 'PENDING_ADMISSION', case_number: 42 },
      addressIds: ['addr-1', 'addr-2'],
    });

    const result = await new ActivatePatientUseCase().execute('pat-1');

    expect(result).toEqual({
      patientId: 'pat-1',
      status: 'ACTIVE',
      createdVacancyIds: ['vac-1', 'vac-2'],
      alreadyActive: false,
    });

    // one INSERT per address
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(2);
    // title uses the patient's case_number + the sequence value
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        patient_id: 'pat-1',
        patient_address_id: 'addr-1',
        case_number: 42,
        computedTitle: 'CASO 42-100',
      }),
    );
    // status moved to ACTIVE, in the same tx, committed once, never rolled back
    expect(countSql(seen, "UPDATE patients SET status = 'ACTIVE'")).toBe(1);
    expect(countSql(seen, 'COMMIT')).toBe(1);
    expect(countSql(seen, 'ROLLBACK')).toBe(0);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('d. with 0 active addresses → NoActiveAddressError, nothing created, rolled back', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-2', status: 'PENDING_ADMISSION', case_number: 7 },
      addressIds: [],
    });

    await expect(new ActivatePatientUseCase().execute('pat-2')).rejects.toBeInstanceOf(
      NoActiveAddressError,
    );

    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
    expect(countSql(seen, 'UPDATE patients SET status')).toBe(0);
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
    expect(countSql(seen, 'COMMIT')).toBe(0);
  });

  it('e. already-ACTIVE patient → idempotent no-op, never duplicates vacancies', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-3', status: 'ACTIVE', case_number: 9 },
      addressIds: ['addr-x'],
    });

    const result = await new ActivatePatientUseCase().execute('pat-3');

    expect(result).toEqual({
      patientId: 'pat-3',
      status: 'ACTIVE',
      createdVacancyIds: [],
      alreadyActive: true,
    });

    // never even looked at addresses, never inserted, never moved status
    expect(countSql(seen, 'FROM patient_addresses')).toBe(0);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
    expect(countSql(seen, 'UPDATE patients SET status')).toBe(0);
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
  });

  it('f. missing patient → PatientNotFoundError', async () => {
    programClient({ patientRow: null });

    await expect(new ActivatePatientUseCase().execute('ghost')).rejects.toBeInstanceOf(
      PatientNotFoundError,
    );
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('g. erro inesperado NÃO-Error (ex.: rejeição de string) → logga com String(err) e propaga; ROLLBACK', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-boom', status: 'PENDING_ADMISSION', case_number: 1 },
      addressIds: ['addr-1'],
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      seen.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'pat-boom', status: 'PENDING_ADMISSION', case_number: 1,
            birth_date: null, has_consent: true, insurance_informed: 'OSDE',
          }],
        };
      }
      if (sql.includes('FROM patient_addresses')) return { rowCount: 1, rows: [{ id: 'addr-1' }] };
      if (sql.includes('nextval')) throw 'plain string rejection'; // eslint-disable-line no-throw-literal
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-boom')).rejects.toBe(
      'plain string rejection',
    );
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('h. move para ACTIVE limpa on_hold_* e grava change_source=activate na mesma transação (QA 🟡2)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-oh', status: 'ON_HOLD', case_number: 55 },
      addressIds: ['addr-1'],
    });

    await new ActivatePatientUseCase().execute('pat-oh');

    const setConfigCalls = mockClient.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("set_config('app.change_source'"),
    );
    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0][1]).toEqual(['activate']);

    const updateCall = mockClient.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE patients SET status'),
    );
    expect(updateCall[0]).toContain('on_hold_reason = NULL');
    expect(updateCall[0]).toContain('on_hold_note = NULL');

    // set_config roda ANTES do UPDATE, na mesma transação (o trigger 254 lê o setting no momento do UPDATE).
    const setConfigIdx = seen.findIndex((s) => s.includes("set_config('app.change_source'"));
    const updateIdx = seen.findIndex((s) => s.includes('UPDATE patients SET status'));
    expect(setConfigIdx).toBeGreaterThan(-1);
    expect(setConfigIdx).toBeLessThan(updateIdx);
  });

  // ── Spec 013 bloco C: cross-product serviço×endereço (linhas 142-151), sem cobertura
  // antes desta rodada (QA-caça #2) ───────────────────────────────────────────────────

  it('l. 2 serviços ativos, cada um no SEU endereço → 2 vagas (uma POR SERVIÇO, nunca serviços × endereços), cada uma no endereço do serviço, com contracted_service_id, providers_needed, franja E horário do serviço', async () => {
    const schedule1 = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
    // Decisão do Gabriel 07/09: os DOIS serviços precisam de horário para o paciente ativar —
    // antes desta rodada o `svc-2` entrava sem horário e a vaga nascia com `schedule: null`.
    // O que este teste mede continua sendo o fim do produto cartesiano; o horário do `svc-2` é
    // agora pré-condição, e a recusa tem teste próprio (`l4`, abaixo).
    const schedule2 = [{ dayOfWeek: 3, startTime: '14:00', endTime: '18:00' }];
    const { seen } = programClient({
      patientRow: { id: 'pat-cross', status: 'PENDING_ADMISSION', case_number: 77 },
      addressIds: ['addr-1', 'addr-2'],
      activeServices: [
        // Migration 330 (decisão do Gabriel 05/09): "Cuidador" é na casa (addr-1) — a vaga nasce
        // SÓ ali. Antes desta migration o produto cartesiano criava svc-1 também em addr-2.
        { id: 'svc-1', providers_needed: 2, provider_age_band: 'AGE_30_45', live_address_id: 'addr-1', schedule: schedule1 },
        // "AT" é na escola (addr-2), com o SEU horário — cada vaga leva o horário do seu serviço.
        { id: 'svc-2', providers_needed: null, live_address_id: 'addr-2', schedule: schedule2 },
      ],
    });

    const result = await new ActivatePatientUseCase().execute('pat-cross');

    // 2 serviços → 2 vagas. Com o produto cartesiano antigo seriam 4 (2 no lugar errado).
    expect(result.createdVacancyIds).toEqual(['vac-1', 'vac-2']);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(2);

    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        patient_address_id: 'addr-1', contracted_service_id: 'svc-1', providers_needed: 2,
        age_range_min: 30, age_range_max: 44, schedule: schedule1,
      }),
    );
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        patient_address_id: 'addr-2', contracted_service_id: 'svc-2', providers_needed: null,
        age_range_min: null, age_range_max: null, schedule: schedule2,
      }),
    );
    // Nenhuma vaga de svc-1 em addr-2 nem de svc-2 em addr-1 — o par errado NÃO existe.
    expect(mockBuildInsertParams).not.toHaveBeenCalledWith(
      expect.objectContaining({ patient_address_id: 'addr-2', contracted_service_id: 'svc-1' }),
    );
    expect(mockBuildInsertParams).not.toHaveBeenCalledWith(
      expect.objectContaining({ patient_address_id: 'addr-1', contracted_service_id: 'svc-2' }),
    );
  });

  it('l2. serviço ativo SEM endereço vivo (address_id NULL ou arquivado) → PatientNotReadyError com SERVICE_ADDRESS, NADA criado, rollback — nunca mais o fallback cartesiano', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-svc-noaddr', status: 'PENDING_ADMISSION', case_number: 78 },
      addressIds: ['addr-1', 'addr-2'],
      activeServices: [
        { id: 'svc-ok', providers_needed: 1, live_address_id: 'addr-1', schedule: HORARIO_OK },
        // O LEFT JOIN devolve null tanto para "nunca vinculado" quanto para "endereço arquivado".
        { id: 'svc-orfao', providers_needed: 1, live_address_id: null, schedule: HORARIO_OK },
      ],
    });

    await expect(new ActivatePatientUseCase().execute('pat-svc-noaddr')).rejects.toMatchObject({
      name: 'PatientNotReadyError',
      missing: ['SERVICE_ADDRESS'],
    });
    // Nem a vaga do serviço "bom" nasce: ou todas, ou nenhuma (mesma transação).
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
    expect(countSql(seen, 'COMMIT')).toBe(0);
  });

  // Decisão do Gabriel 07/09: horário do serviço é pré-condição da ativação.
  it('l4. serviço ativo SEM horário (null) → PatientNotReadyError com SERVICE_SCHEDULE, NADA criado, rollback', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-sem-horario', status: 'PENDING_ADMISSION', case_number: 80 },
      addressIds: ['addr-1'],
      activeServices: [{ id: 'svc-1', providers_needed: 1, live_address_id: 'addr-1' }],
    });

    await expect(new ActivatePatientUseCase().execute('pat-sem-horario')).rejects.toMatchObject({
      name: 'PatientNotReadyError',
      missing: ['SERVICE_SCHEDULE'],
    });
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
    expect(countSql(seen, 'COMMIT')).toBe(0);
  });

  it('l5. horário ARRAY VAZIO conta como sem horário — o CHECK do banco aceita `[]`, só a borda zod normaliza', async () => {
    programClient({
      patientRow: { id: 'pat-horario-vazio', status: 'PENDING_ADMISSION', case_number: 81 },
      addressIds: ['addr-1'],
      activeServices: [{ id: 'svc-1', providers_needed: 1, live_address_id: 'addr-1', schedule: [] }],
    });

    await expect(new ActivatePatientUseCase().execute('pat-horario-vazio')).rejects.toMatchObject({
      missing: ['SERVICE_SCHEDULE'],
    });
  });

  it('l6. UM serviço com horário e outro SEM → bloqueia (a régua é "todo serviço ativo")', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-misto', status: 'PENDING_ADMISSION', case_number: 82 },
      addressIds: ['addr-1', 'addr-2'],
      activeServices: [
        { id: 'svc-com', providers_needed: 1, live_address_id: 'addr-1', schedule: HORARIO_OK },
        { id: 'svc-sem', providers_needed: 1, live_address_id: 'addr-2' },
      ],
    });

    await expect(new ActivatePatientUseCase().execute('pat-misto')).rejects.toMatchObject({
      missing: ['SERVICE_SCHEDULE'],
    });
    // Nem a vaga do serviço COM horário nasce — ou todas, ou nenhuma.
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
  });

  it('l7. paciente SEM serviço nenhum continua ativável — SERVICE_SCHEDULE não acusa (fallback por endereço)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-sem-servico', status: 'PENDING_ADMISSION', case_number: 83 },
      addressIds: ['addr-1'],
    });

    const r = await new ActivatePatientUseCase().execute('pat-sem-servico');
    expect(r.status).toBe('ACTIVE');
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);
  });

  it('l3. a query de serviços faz LEFT JOIN em patient_addresses NÃO arquivado — endereço arquivado conta como "sem endereço"', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-q', status: 'PENDING_ADMISSION', case_number: 79 },
      addressIds: ['addr-1'],
      activeServices: [{ id: 'svc-1', providers_needed: 1, live_address_id: 'addr-1', schedule: HORARIO_OK }],
    });
    await new ActivatePatientUseCase().execute('pat-q');
    const svcSql = seen.find((q) => q.includes('FROM patient_contracted_services'))!;
    expect(svcSql).toMatch(/LEFT JOIN patient_addresses pa/);
    expect(svcSql).toMatch(/pa\.archived_at IS NULL/);
    expect(svcSql).toMatch(/pcs\.schedule/);
    // O produto cartesiano morreu: a query de endereços continua existindo (gate ADDRESS e
    // fallback sem serviço), mas com serviço a vaga nasce do serviço.
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);
  });

  // ── Spec 015 (US-A6.2, T003 "teste unitário direto"): os 4 valores do enum, isolados ────────
  it.each([
    ['ANY', null, null],
    ['AGE_20_30', 20, 29],
    ['AGE_30_45', 30, 44],
    ['AGE_45_PLUS', 45, null],
  ])('n. serviço com provider_age_band=%s → vaga com age_range_min=%s, age_range_max=%s', async (band, min, max) => {
    programClient({
      patientRow: { id: 'pat-band', status: 'PENDING_ADMISSION', case_number: 99 },
      addressIds: ['addr-1'],
      activeServices: [{ id: 'svc-band', providers_needed: 1, provider_age_band: band as string, live_address_id: 'addr-1', schedule: HORARIO_OK }],
    });

    await new ActivatePatientUseCase().execute('pat-band');

    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ contracted_service_id: 'svc-band', age_range_min: min, age_range_max: max }),
    );
  });

  it('m. serviço inativo só (zero linhas ativas) → fallback: 1 vaga por endereço, contracted_service_id null', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-fallback', status: 'PENDING_ADMISSION', case_number: 88 },
      addressIds: ['addr-only'],
      // A query já filtra `WHERE active` — um paciente com serviço(s) só INATIVO(s) chega aqui
      // com a mesma lista vazia de "nenhum serviço declarado" (mesmo shape, é o ponto do teste).
      activeServices: [],
    });

    const result = await new ActivatePatientUseCase().execute('pat-fallback');

    expect(result.createdVacancyIds).toEqual(['vac-1']);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        patient_address_id: 'addr-only', contracted_service_id: null, providers_needed: null,
        age_range_min: null, age_range_max: null,
      }),
    );
  });

  // ── Ramos pré-existentes do arquivo, sem cobertura antes desta rodada (D200: 100% do
  // arquivo TOCADO, não só das linhas novas) ──────────────────────────────────────────

  it('i. driver devolve rowCount undefined para o SELECT do paciente (?? 0) → mesmo tratamento de "não achei"', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return { rows: [] }; // rowCount ausente (undefined), não `0` explícito — é o outro lado do `??`
      }
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-undef')).rejects.toBeInstanceOf(
      PatientNotFoundError,
    );
  });

  it('j. driver devolve rowCount undefined para o SELECT de endereços (?? 0) → NoActiveAddressError', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'pat-4', status: 'PENDING_ADMISSION', case_number: 3,
            birth_date: null, has_consent: true, insurance_informed: 'OSDE',
          }],
        };
      }
      if (sql.includes('FROM patient_addresses')) return { rows: [] }; // rowCount ausente
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-4')).rejects.toBeInstanceOf(
      NoActiveAddressError,
    );
  });

  it('k. ROLLBACK do catch-de-fallback também falha (transação já fechada) → o erro original ainda propaga, sem 2ª exceção', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') return {};
      if (sql === 'ROLLBACK') throw new Error('connection terminated');
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'pat-5', status: 'PENDING_ADMISSION', case_number: 3 }] };
      }
      if (sql.includes('FROM patient_addresses')) throw new Error('conexão caiu no meio do SELECT');
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-5')).rejects.toThrow(
      'conexão caiu no meio do SELECT',
    );
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  // ── Spec 014 (US-D1/SUP-D1, lex D1.1/D1.2): checklist único, GATE = SÓ ADDRESS ──────────
  // Decisão do Gabriel 03/09 (medida na réplica de produção: 370 pacientes vivos, 23 com
  // has_consent=true — `has_consent` só é gravado pelo espelho do ClickUp/formulário público,
  // nunca pelo painel): RESPONSIBLE/COVERAGE/CONSENT ficam SÓ no checklist informativo
  // (`computePatientCompleteness`/`GET /:id`), nunca bloqueiam `POST /activate`. Exatamente
  // como CONTRACTED_SERVICE (testes s/u abaixo, que já provavam o mesmo padrão pré-existente).

  it('n. sem consentimento → NÃO bloqueia o activate (só ADDRESS bloqueia); computePatientCompleteness ainda reporta CONSENT em missing (checklist)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-noconsent', status: 'PENDING_ADMISSION', case_number: 10, has_consent: false },
      addressIds: ['addr-1'],
    });

    const result = await new ActivatePatientUseCase().execute('pat-noconsent');
    expect(result.alreadyActive).toBe(false);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);
    expect(countSql(seen, 'COMMIT')).toBe(1);

    const { missing } = computePatientCompleteness({
      birthDate: null,
      hasConsent: false,
      insuranceInformed: 'OSDE',
      activeAddressCount: 1,
      activeResponsibleCount: 0,
      activeContractedServiceCount: 0,
      activeContractedServicesWithoutAddressCount: 0,
      activeContractedServicesWithoutScheduleCount: 0,
    });
    expect(missing).toContain('CONSENT');
  });

  it('o. sem cobertura informada → NÃO bloqueia o activate; missing ainda contém COVERAGE (checklist)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-nocov', status: 'PENDING_ADMISSION', case_number: 11, insurance_informed: null },
      addressIds: ['addr-1'],
    });

    const result = await new ActivatePatientUseCase().execute('pat-nocov');
    expect(result.alreadyActive).toBe(false);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);

    const { missing } = computePatientCompleteness({
      birthDate: null,
      hasConsent: true,
      insuranceInformed: null,
      activeAddressCount: 1,
      activeResponsibleCount: 0,
      activeContractedServiceCount: 0,
      activeContractedServicesWithoutAddressCount: 0,
      activeContractedServicesWithoutScheduleCount: 0,
    });
    expect(missing).toContain('COVERAGE');
  });

  it('p. paciente MENOR sem responsável → NÃO bloqueia o activate; missing ainda contém RESPONSIBLE (checklist)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-minor', status: 'PENDING_ADMISSION', case_number: 12, birth_date: '2015-01-01' },
      addressIds: ['addr-1'],
      responsibleCount: 0,
    });

    const result = await new ActivatePatientUseCase().execute('pat-minor');
    expect(result.alreadyActive).toBe(false);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);

    const { missing } = computePatientCompleteness({
      birthDate: '2015-01-01',
      hasConsent: true,
      insuranceInformed: 'OSDE',
      activeAddressCount: 1,
      activeResponsibleCount: 0,
      activeContractedServiceCount: 0,
      activeContractedServicesWithoutAddressCount: 0,
      activeContractedServicesWithoutScheduleCount: 0,
    });
    expect(missing).toContain('RESPONSIBLE');
  });

  // 3º sítio de contagem de responsáveis (achado do gate `revisao-pr`, spec 018 PR-1, FR-004):
  // a query aqui é a MESMA fonte que alimenta `activeResponsibleCount` — sem `AND active`, um
  // responsável desativado (nunca DELETE, migration 420) contaria como presente e o checklist
  // mentiria "RESPONSIBLE ok" para um menor cujo único responsável foi removido.
  it('p2. a contagem de responsáveis filtra `active` — a query em patient_responsibles nunca conta linha desativada', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-minor-resp-inativo', status: 'PENDING_ADMISSION', case_number: 13, birth_date: '2015-01-01' },
      addressIds: ['addr-1'],
      responsibleCount: 0,
    });

    await new ActivatePatientUseCase().execute('pat-minor-resp-inativo');

    const respSql = seen.find((sql) => sql.includes('FROM patient_responsibles'));
    expect(respSql).toBeDefined();
    expect(respSql).toMatch(/\bactive\b/);
  });

  it('v. SEM endereço E sem consentimento/cobertura/responsável (menor) ao mesmo tempo → ainda assim NoActiveAddressError (só ADDRESS decide), nunca PatientNotReadyError genérico', async () => {
    const { seen } = programClient({
      patientRow: {
        id: 'pat-multi-missing',
        status: 'PENDING_ADMISSION',
        case_number: 20,
        birth_date: '2015-01-01',
        has_consent: false,
        insurance_informed: null,
      },
      addressIds: [],
      responsibleCount: 0,
    });

    const err = await new ActivatePatientUseCase().execute('pat-multi-missing').catch((e) => e);
    expect(err).toBeInstanceOf(NoActiveAddressError);
    expect((err as PatientNotReadyError).missing).toEqual(['ADDRESS']);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
  });

  // ── C9: o erro tem de dizer o que REALMENTE falta ────────────────────────────────────────
  //
  // O gate lê `blocking` corretamente, mas sempre lançava `NoActiveAddressError`, que hardcoda
  // `missing: ['ADDRESS']` e a mensagem "agregá al menos una dirección". Latente enquanto
  // ACTIVATION_BLOCKING_CODES tem 1 item — e mentira no dia em que ganhar o segundo (a constante
  // existe justamente para crescer: "reversível, é só ACTIVATION_BLOCKING_CODES ganhar mais códigos").
  describe('C9 — o 422 nomeia os códigos que o gate realmente barrou', () => {
    const bloqueando = (codes: Array<'ADDRESS' | 'RESPONSIBLE' | 'COVERAGE' | 'CONTRACTED_SERVICE' | 'CONSENT'>) =>
      jest.spyOn(PatientCompletenessModule, 'computePatientCompleteness').mockReturnValue({
        missing: codes, blocking: codes, ready: false, canActivate: false,
      });

    afterEach(() => { jest.restoreAllMocks(); });

    it('dois códigos bloqueando → PatientNotReadyError com os DOIS, e a mensagem não fala só de endereço', async () => {
      bloqueando(['ADDRESS', 'CONSENT']);
      const { seen } = programClient({
        patientRow: { id: 'pat-c9-dois', status: 'PENDING_ADMISSION', case_number: 91 },
        addressIds: [],
        responsibleCount: 0,
      });
      const err = await new ActivatePatientUseCase().execute('pat-c9-dois').catch((e) => e);
      expect(err).toBeInstanceOf(PatientNotReadyError);
      expect((err as PatientNotReadyError).missing).toEqual(['ADDRESS', 'CONSENT']);
      expect((err as Error).message).toContain('CONSENT');
      expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
      expect(countSql(seen, 'ROLLBACK')).toBe(1);
    });

    it('um código que NÃO é ADDRESS → o erro não pode ser NoActiveAddressError (o endereço existe)', async () => {
      bloqueando(['CONSENT']);
      programClient({
        patientRow: { id: 'pat-c9-consent', status: 'PENDING_ADMISSION', case_number: 92 },
        addressIds: ['addr-1'],
        responsibleCount: 1,
      });
      const err = await new ActivatePatientUseCase().execute('pat-c9-consent').catch((e) => e);
      expect(err).toBeInstanceOf(PatientNotReadyError);
      expect(err).not.toBeInstanceOf(NoActiveAddressError);
      expect((err as PatientNotReadyError).missing).toEqual(['CONSENT']);
    });

    it('só ADDRESS (o caso de hoje) segue sendo NoActiveAddressError — nada mudou para quem já dependia disso', async () => {
      bloqueando(['ADDRESS']);
      programClient({
        patientRow: { id: 'pat-c9-addr', status: 'PENDING_ADMISSION', case_number: 93 },
        addressIds: [],
        responsibleCount: 1,
      });
      const err = await new ActivatePatientUseCase().execute('pat-c9-addr').catch((e) => e);
      expect(err).toBeInstanceOf(NoActiveAddressError);
      expect((err as PatientNotReadyError).missing).toEqual(['ADDRESS']);
    });
  });

  it('q. paciente MENOR com ≥1 responsável → RESPONSIBLE não bloqueia (ativa normalmente)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-minor-ok', status: 'PENDING_ADMISSION', case_number: 13, birth_date: '2015-01-01' },
      addressIds: ['addr-1'],
      responsibleCount: 1,
    });

    const result = await new ActivatePatientUseCase().execute('pat-minor-ok');
    expect(result.alreadyActive).toBe(false);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);
  });

  it('r. paciente ADULTO SEM responsável ativa normalmente (RESPONSIBLE não é exigido de maior)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-adult-ok', status: 'PENDING_ADMISSION', case_number: 14 },
      addressIds: ['addr-1'],
      responsibleCount: 0,
    });

    const result = await new ActivatePatientUseCase().execute('pat-adult-ok');
    expect(result.alreadyActive).toBe(false);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);
  });

  it(
    's. ZERO serviço contratado ativo NÃO bloqueia o gate (fallback do bloco C, decisão declarada' +
      ' no docblock) — mesmo assim CONTRACTED_SERVICE apareceria no checklist da ficha',
    async () => {
      const { seen } = programClient({
        patientRow: { id: 'pat-noservice-ok', status: 'PENDING_ADMISSION', case_number: 15 },
        addressIds: ['addr-1'],
        // activeServices ausente → [] → CONTRACTED_SERVICE estaria em `missing`, mas não em
        // `blocking` — é exatamente o comportamento pré-existente (testes c/l/m acima).
      });

      const result = await new ActivatePatientUseCase().execute('pat-noservice-ok');
      expect(result.alreadyActive).toBe(false);
      expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);

      // Prova de que o gate LÊ a mesma função do checklist em vez de reimplementar a regra:
      // para o MESMO estado do paciente, `computePatientCompleteness` (a função que também
      // alimenta `GET /:id`) AINDA reporta CONTRACTED_SERVICE em `missing` — só não entra no
      // `blocking` do activate. Se alguém duplicar a lógica em vez de importar a função, este
      // teste não capta a divergência sozinho; o de baixo (t) capta.
      const { missing } = computePatientCompleteness({
        birthDate: null,
        hasConsent: true,
        insuranceInformed: 'OSDE',
        activeAddressCount: 1,
        activeResponsibleCount: 0,
        activeContractedServiceCount: 0,
        activeContractedServicesWithoutAddressCount: 0,
        activeContractedServicesWithoutScheduleCount: 0,
      });
      expect(missing).toEqual(['CONTRACTED_SERVICE']);
    },
  );

  it('u. driver devolve rowCount undefined para o SELECT de serviços (?? 0) → CONTRACTED_SERVICE some do missing sem quebrar (não bloqueia mesmo assim)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-svc-undef', status: 'PENDING_ADMISSION', case_number: 16 },
      addressIds: ['addr-1'],
    });
    const original = mockClient.query.getMockImplementation()!;
    mockClient.query.mockImplementation(async (sql: string, params?: unknown) => {
      if (sql.includes('FROM patient_contracted_services')) return { rows: [] }; // rowCount ausente
      return original(sql, params);
    });

    const result = await new ActivatePatientUseCase().execute('pat-svc-undef');
    expect(result.alreadyActive).toBe(false);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(1);
  });

  it('t. o gate importa PATIENT_COMPLETENESS_CODES/computePatientCompleteness do módulo de domínio — não reimplementa os códigos', () => {
    // Lex D1.2: constante única. Se o arquivo do use case declarasse sua PRÓPRIA lista de
    // códigos (cópia, drift possível), este `grep` estrutural pegaria — a fonte é IMPORTADA.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../ActivatePatientUseCase.ts'),
      'utf-8',
    );
    expect(source).toMatch(/import\s*\{\s*\n?\s*computePatientCompleteness/);
    expect(source).not.toMatch(/const\s+PATIENT_COMPLETENESS_CODES\s*=/);
  });

  it('w. (QA-caça rodada 1, item conserto D255) o gate lê `blocking` de computePatientCompleteness — não reimplementa "só ADDRESS bloqueia" com missing.includes', () => {
    // A causa-raiz do defeito 2 do QA-caça: o gate comparava `missing.includes('ADDRESS')`
    // direto, uma cópia local da regra "ADDRESS é o único bloqueante" que só por coincidência
    // batia com ACTIVATION_BLOCKING_CODES. Fonte única: o use case lê `blocking` (já filtrado
    // pela constante) em vez de reimplementar o filtro.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../ActivatePatientUseCase.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/missing\.includes\(\s*['"]ADDRESS['"]\s*\)/);
    expect(source).toMatch(/blocking/);
  });
});
