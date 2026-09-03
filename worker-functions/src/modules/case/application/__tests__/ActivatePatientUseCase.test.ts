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
  activeServices?: Array<{ id: string; providers_needed: number | null; provider_age_band?: string | null }>;
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
      const rows = opts.activeServices ?? [];
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

  it('l. 2 serviços ativos × 2 endereços ativos → 4 vagas (cross-product), cada uma com o contracted_service_id do serviço certo, providers_needed E a franja (age_range_min/max) propagados', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-cross', status: 'PENDING_ADMISSION', case_number: 77 },
      addressIds: ['addr-1', 'addr-2'],
      activeServices: [
        // Spec 015 (US-A6.2): svc-1 pediu franja 30-45 → toda vaga NASCIDA DESTE SERVIÇO carrega
        // age_range_min=30/max=44 (ProviderAgeBandMapping.ts), em QUALQUER endereço.
        { id: 'svc-1', providers_needed: 2, provider_age_band: 'AGE_30_45' },
        // svc-2 nunca teve a franja preenchida (coluna nova em serviço pré-existente) →
        // não toca a vaga (null/null), MESMO shape do fallback.
        { id: 'svc-2', providers_needed: null },
      ],
    });

    const result = await new ActivatePatientUseCase().execute('pat-cross');

    // 2 endereços × 2 serviços = 4 vagas — linha 145 (o `.map` interno) é o que gera o produto
    // cartesiano por endereço; sem ela haveria só 2 vagas (uma por endereço, sem serviço).
    expect(result.createdVacancyIds).toEqual(['vac-1', 'vac-2', 'vac-3', 'vac-4']);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(4);

    // Ordem: flatMap por endereço, map interno por serviço — addr-1×svc-1, addr-1×svc-2,
    // addr-2×svc-1, addr-2×svc-2. Cada chamada carrega o par CERTO (não o último serviço para
    // todas as vagas — o bug óbvio de closure/reuso de variável nesta forma de loop).
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        patient_address_id: 'addr-1', contracted_service_id: 'svc-1', providers_needed: 2,
        age_range_min: 30, age_range_max: 44,
      }),
    );
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        patient_address_id: 'addr-1', contracted_service_id: 'svc-2', providers_needed: null,
        age_range_min: null, age_range_max: null,
      }),
    );
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        patient_address_id: 'addr-2', contracted_service_id: 'svc-1', providers_needed: 2,
        age_range_min: 30, age_range_max: 44,
      }),
    );
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        patient_address_id: 'addr-2', contracted_service_id: 'svc-2', providers_needed: null,
        age_range_min: null, age_range_max: null,
      }),
    );
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
      activeServices: [{ id: 'svc-band', providers_needed: 1, provider_age_band: band as string }],
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
    });
    expect(missing).toContain('RESPONSIBLE');
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
