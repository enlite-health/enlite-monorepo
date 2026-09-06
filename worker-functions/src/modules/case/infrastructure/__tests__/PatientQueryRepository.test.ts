/**
 * PatientQueryRepository — unit tests.
 *
 * Had ZERO coverage before this file (11.9% lines). Constructor calls
 * DatabaseConnection.getInstance().getPool(), so we mock that module the
 * same way PatientClinicalRepository.test.ts does.
 *
 * Covers:
 *   a. list() — SQL params order/positions, total from COUNT(*) OVER(),
 *      total=0 when 0 rows, row mapping (isTest coercion, addressesCount/
 *      caseNumber parseInt, SLA fields via derivePatientSla), all filter
 *      ternary branches (needs_attention true/false/absent).
 *   b. stats() — country present/absent, numeric coercion of every field.
 *   c. findDetailById() — delegates to fetchPatientDetail(pool, encSvc, id).
 */

const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: jest.fn(), decrypt: jest.fn() })),
}));

const mockFetchPatientDetail = jest.fn();
jest.mock('../PatientDetailQueryHelper', () => ({
  fetchPatientDetail: (...args: unknown[]) => mockFetchPatientDetail(...args),
}));

import { PatientQueryRepository } from '../PatientQueryRepository';
import type { AdminPatientsListParams } from '../../interfaces/validators/adminPatientsListSchema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseFilters(overrides: Partial<AdminPatientsListParams> = {}): AdminPatientsListParams {
  return {
    limit: 20,
    offset: 0,
    ...overrides,
  } as AdminPatientsListParams;
}

function baseListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    isTest: false,
    clickupTaskId: 'CU-1',
    firstName: 'Ana',
    lastName: 'García',
    diagnosis: 'ASD',
    dependencyLevel: 'MILD',
    clinicalSpecialty: 'ASD',
    serviceType: ['AT'],
    documentType: 'DNI',
    documentNumber: '1',
    sex: 'FEMALE',
    status: 'ACTIVE',
    needsAttention: false,
    attentionReasons: [],
    addressesCount: '2',
    caseNumber: '766',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-06-01T00:00:00Z'),
    stageEnteredAt: new Date('2025-01-02T00:00:00Z').toISOString(),
    total_count: '1',
    // QA-caça rodada 1, item conserto 1 (D1.1/D255): insumos do checklist, EXISTS/booleanos —
    // default "tudo completo" para não quebrar as asserções pré-existentes de needsAttention
    // (que não conheciam esta derivação). Cada teste novo sobrescreve o que quer testar.
    birthDate: null,
    hasConsent: true,
    insuranceInformed: 'OSDE',
    // ADDRESS não tem coluna própria: reusa addressesCount (default '2' acima = presente).
    hasActiveResponsible: true,
    hasActiveContractedService: true,
    // Migration 330: serviço ativo sem endereço vivo — default false (= vinculado).
    hasActiveServiceWithoutAddress: false,
    ...overrides,
  };
}

// ── list() ────────────────────────────────────────────────────────────────────

describe('PatientQueryRepository.list', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('a1. monta os params na ordem certa e mapeia rows + total (isTest, addressesCount, caseNumber, SLA)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow()] });
    const repo = new PatientQueryRepository();

    const { rows, total } = await repo.list(
      baseFilters({
        search: '  Ana  ',
        needs_attention: 'true',
        attention_reason: 'MISSING_INFO',
        clinical_specialty: 'ASD',
        dependency_level: 'MILD',
        case_number: '766',
        country: 'AR',
        limit: 20,
        offset: 0,
      }),
    );

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'p1',
      isTest: false,
      addressesCount: 2,
      caseNumber: 766,
    });
    expect(rows[0].stageEnteredAt).not.toBeNull();

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('FROM patients p');
    // $1 search (trimmed), $2 needsAttention bool, $3 attentionReason,
    // $4 clinicalSpecialty, $5 dependencyLevel, $6 caseNumber, $7 country,
    // $8 limit, $9 offset.
    expect(params).toEqual(['Ana', true, 'MISSING_INFO', 'ASD', 'MILD', '766', 'AR', 20, 0]);
  });

  it('a2. isTest=true quando a linha marca is_test', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ isTest: true })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].isTest).toBe(true);
  });

  it('a3. needs_attention="false" → filtro boolean false', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    await repo.list(baseFilters({ needs_attention: 'false' }));
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[1]).toBe(false);
  });

  it('a4. needs_attention ausente → filtro null (todos)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    await repo.list(baseFilters());
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[1]).toBeNull();
  });

  it('a5. search vazio/whitespace → null (sem filtro)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    await repo.list(baseFilters({ search: '   ' }));
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[0]).toBeNull();
  });

  it('a6. 0 rows → total=0 (branch: result.rows.length > 0 falso)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    const { rows, total } = await repo.list(baseFilters());
    expect(total).toBe(0);
    expect(rows).toEqual([]);
  });

  it('a6b. responsibleName com o placeholder pré-D249 sai como null', async () => {
    // As 6 fichas antigas com familiar têm 'Solicitante' em patient_responsibles.
    // "Responsável: Solicitante" seria trocar um card mudo por outro.
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ responsibleName: 'Solicitante' })],
    });

    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters({ limit: 20, offset: 0 }));

    expect(rows[0].responsibleName).toBeNull();
  });

  it('a6c. responsibleName real passa; ausente vira null', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ responsibleName: 'flavia villagra' })],
    });
    const repo = new PatientQueryRepository();
    const comNome = await repo.list(baseFilters({ limit: 20, offset: 0 }));
    expect(comNome.rows[0].responsibleName).toBe('flavia villagra');

    // Coluna ausente na linha (não `null`): o `?? null` do mapeamento.
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow()] });
    const semNome = await repo.list(baseFilters({ limit: 20, offset: 0 }));
    expect(semNome.rows[0].responsibleName).toBeNull();
  });

  it('a7. attentionReasons ausente na linha → [] no mapeamento', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ attentionReasons: undefined })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].attentionReasons).toEqual([]);
  });

  it('a8. caseNumber null na linha → null no mapeamento (sem parseInt)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ caseNumber: null })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].caseNumber).toBeNull();
  });

  it('a9. addressesCount não numérico → 0 (fallback || 0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ addressesCount: null })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].addressesCount).toBe(0);
  });

  it('a10. stageEnteredAt null → sla.stageEnteredAt null (derivePatientSla com stageEnteredAt=null)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ stageEnteredAt: null })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].stageEnteredAt).toBeNull();
    expect(rows[0].hoursInStage).toBeNull();
  });

  // ── QA-caça rodada 1, item conserto 1 (D1.1/D255): needsAttention DERIVA do checklist ──────
  // Reprodução do defeito: paciente com `completeness.missing` não vazio no GET /:id continuava
  // `needsAttention:false` na lista, porque a coluna legada `patients.needs_attention` nunca era
  // recalculada. Agora: needsAttention = legado OR (status ∈ ACTIVATABLE_STATUSES AND
  // missing.length > 0). NUNCA expõe `missing`/`completeness` — só o booleano derivado.

  it('a11. status ADMISSION + falta endereço (checklist incompleto) + legado=false → needsAttention TRUE, attentionReasons ganha INCOMPLETE_ADMISSION', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        baseListRow({
          status: 'ADMISSION',
          needsAttention: false,
          attentionReasons: [],
          // ADDRESS reusa addressesCount (não há coluna hasActiveAddress separada — ver a17).
          addressesCount: '0',
        }),
      ],
    });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].attentionReasons).toContain('INCOMPLETE_ADMISSION');
  });

  it('a12. status ACTIVE (fora de ACTIVATABLE_STATUSES) + checklist incompleto → needsAttention continua FALSE (não deriva fora da admissão)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        baseListRow({
          status: 'ACTIVE',
          needsAttention: false,
          addressesCount: '0',
          hasConsent: false,
        }),
      ],
    });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].needsAttention).toBe(false);
    expect(rows[0].attentionReasons).not.toContain('INCOMPLETE_ADMISSION');
  });

  it('a13. legado needsAttention=true SEMPRE prevalece (OR), mesmo com checklist completo', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ status: 'PENDING_ADMISSION', needsAttention: true, attentionReasons: ['MISSING_INFO'] })],
    });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].attentionReasons).toEqual(['MISSING_INFO']);
    expect(rows[0].attentionReasons).not.toContain('INCOMPLETE_ADMISSION');
  });

  // Migration 330: a listagem projeta `hasActiveServiceWithoutAddress` (LEFT JOIN em endereço
  // vivo) e o traduz para o insumo do checklist — SERVICE_ADDRESS sozinho já marca a linha.
  it('a11b. status ADMISSION + tudo completo MENOS o vínculo serviço→endereço → needsAttention TRUE, INCOMPLETE_ADMISSION', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ status: 'ADMISSION', needsAttention: false, attentionReasons: [], hasActiveServiceWithoutAddress: true })],
    });
    const repo = new PatientQueryRepository();
    const { rows } = await repo.list(baseFilters());
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].attentionReasons).toContain('INCOMPLETE_ADMISSION');
    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/hasActiveServiceWithoutAddress/);
    expect(sql).toMatch(/LEFT JOIN patient_addresses pa\s+ON pa\.id = pcs\.address_id AND pa\.archived_at IS NULL/);
  });

  it('a14. status PENDING_ADMISSION + checklist COMPLETO → needsAttention false, sem INCOMPLETE_ADMISSION', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ status: 'PENDING_ADMISSION', needsAttention: false })],
    });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].needsAttention).toBe(false);
    expect(rows[0].attentionReasons).toEqual([]);
  });

  it('a14b. attentionReasons já tem INCOMPLETE_ADMISSION gravado (legado) → não duplica ao derivar de novo', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        baseListRow({
          status: 'ADMISSION',
          needsAttention: false,
          attentionReasons: ['INCOMPLETE_ADMISSION'],
          addressesCount: '0',
        }),
      ],
    });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].needsAttention).toBe(true);
    // Exatamente UMA ocorrência — o branch `legacyReasons.includes(...)` evita duplicar.
    expect(rows[0].attentionReasons.filter((r) => r === 'INCOMPLETE_ADMISSION')).toHaveLength(1);
  });

  it('a15. paciente MENOR sem responsável em ADMISSION → RESPONSIBLE falta, needsAttention true', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        baseListRow({
          status: 'ADMISSION',
          birthDate: '2015-01-01',
          hasActiveResponsible: false,
        }),
      ],
    });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].needsAttention).toBe(true);
    expect(rows[0].attentionReasons).toContain('INCOMPLETE_ADMISSION');
  });

  it('a16. a linha mapeada NUNCA carrega `missing`/`completeness` (lex D1.1: só no detalhe)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ status: 'ADMISSION', hasActiveAddress: false })],
    });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0]).not.toHaveProperty('missing');
    expect(rows[0]).not.toHaveProperty('completeness');
  });

  it('a17. SQL da list() usa EXISTS/booleano (correlated subquery) para os insumos do checklist — reusa addressesCount, não decripta, não faz N+1 por linha', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();
    await repo.list(baseFilters());

    const [sql] = mockPoolQuery.mock.calls[0];
    // ADDRESS reusa a subquery de addressesCount já existente (sem duplicar o EXISTS).
    expect(sql).toMatch(/addressesCount/);
    // RESPONSIBLE/CONTRACTED_SERVICE viram booleano via EXISTS — novos, correlated na MESMA query.
    expect(sql).toMatch(/hasActiveResponsible/);
    expect(sql).toMatch(/hasActiveContractedService/);
    expect(sql).toMatch(/EXISTS/);
    // COVERAGE/CONSENT/birthDate são colunas diretas de `patients`, sem subquery.
    expect(sql).toMatch(/hasConsent/);
    expect(sql).toMatch(/"birthDate"/);
    // list() continua UMA query — nenhum await extra por paciente (a KMSEncryptionService não é
    // chamada por este caminho: nenhum dos insumos do checklist é PII cifrada).
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

// ── stats() ───────────────────────────────────────────────────────────────────

describe('PatientQueryRepository.stats', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  function statsRow(overrides: Record<string, unknown> = {}) {
    return {
      total: '10',
      complete: '7',
      needs_attention: '3',
      created_today: '1',
      created_yesterday: '2',
      created_last_7_days: '5',
      ...overrides,
    };
  }

  it('b1. sem country → passa null e coerce todos os campos pra número', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [statsRow()] });
    const repo = new PatientQueryRepository();

    const result = await repo.stats();

    expect(mockPoolQuery.mock.calls[0][1]).toEqual([null]);
    expect(result).toEqual({
      total: 10,
      complete: 7,
      needsAttention: 3,
      createdToday: 1,
      createdYesterday: 2,
      createdLast7Days: 5,
    });
  });

  it('b2. com country=BR → passa "BR" como param', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [statsRow()] });
    const repo = new PatientQueryRepository();

    await repo.stats('BR');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['BR']);
  });
});

// ── findDetailById() ─────────────────────────────────────────────────────────

describe('PatientQueryRepository.findDetailById', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockFetchPatientDetail.mockReset();
  });

  it('c1. delega para fetchPatientDetail com (pool, encryptionService, id)', async () => {
    const detail = { id: 'p1' } as never;
    mockFetchPatientDetail.mockResolvedValueOnce(detail);
    const repo = new PatientQueryRepository();

    const result = await repo.findDetailById('p1');

    expect(result).toBe(detail);
    expect(mockFetchPatientDetail).toHaveBeenCalledTimes(1);
    const [pool, encSvc, id] = mockFetchPatientDetail.mock.calls[0];
    expect(id).toBe('p1');
    expect(pool).toBeDefined();
    expect(encSvc).toBeDefined();
  });

  it('c2. propaga null quando fetchPatientDetail não encontra o paciente', async () => {
    mockFetchPatientDetail.mockResolvedValueOnce(null);
    const repo = new PatientQueryRepository();

    const result = await repo.findDetailById('missing');
    expect(result).toBeNull();
  });
});
