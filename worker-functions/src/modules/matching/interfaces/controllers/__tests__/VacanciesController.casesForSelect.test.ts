/**
 * VacanciesController.casesForSelect.test.ts
 *
 * Testa getCasesForSelect após reescrita da Frente 4 (TD-004):
 * - query parte de `patients` direto, sem JOIN com job_postings
 * - pacientes sem vaga prévia aparecem no select
 * - shape de resposta preservado: { caseNumber, patientId, dependencyLevel }
 *
 * Cenários:
 *   1. ACTIVE + needs_attention=false + case_number + endereço → aparece
 *   2. ACTIVE sem vaga → aparece (motivação central da reescrita)
 *   3. ACTIVE com vaga → aparece (legado continua funcionando)
 *   4. DISCONTINUED → não aparece
 *   5. needs_attention=true → não aparece
 *   6. case_number IS NULL → não aparece
 *   7. sem endereço → não aparece
 *   8. deleted_at IS NOT NULL → não aparece
 *   9. SQL usa p.case_number e p.deleted_at (invariante estrutural)
 *  10. retorna 500 quando query lança exceção
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

import { VacanciesController } from '../VacanciesController';
import { Request, Response } from 'express';

// ─── helpers ──────────────────────────────────────────────────────────────────

function mockReqRes(): [Request, Response] {
  const req = { params: {}, query: {}, body: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function makePatientRow(overrides: Record<string, unknown> = {}) {
  return {
    caseNumber: 764,
    patientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    dependencyLevel: 'MODERATE',
    ...overrides,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('VacanciesController.getCasesForSelect', () => {
  let controller: VacanciesController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new VacanciesController();
  });

  // ── cenário 1: paciente ACTIVE com endereço → aparece ──────────────────────

  it('retorna paciente ACTIVE com case_number e endereço', async () => {
    const row = makePatientRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [row],
    });
  });

  // ── cenário 2: ACTIVE sem vaga → aparece (motivação da reescrita) ──────────

  it('paciente ACTIVE sem job_postings aparece no resultado', async () => {
    const rowSemVaga = makePatientRow({ caseNumber: 765, patientId: 'sem-vaga-uuid' });
    mockQuery.mockResolvedValueOnce({ rows: [rowSemVaga] });

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = (res.json as jest.Mock).mock.calls[0][0].data as unknown[];
    expect(data).toHaveLength(1);
    expect((data[0] as { caseNumber: number }).caseNumber).toBe(765);
  });

  // ── cenário 3: múltiplos pacientes retornados em ordem DESC ────────────────

  it('retorna múltiplos pacientes ordenados por case_number DESC', async () => {
    const rows = [
      makePatientRow({ caseNumber: 766 }),
      makePatientRow({ caseNumber: 765 }),
      makePatientRow({ caseNumber: 764 }),
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = (res.json as jest.Mock).mock.calls[0][0].data as Array<{ caseNumber: number }>;
    expect(data[0].caseNumber).toBe(766);
    expect(data[1].caseNumber).toBe(765);
    expect(data[2].caseNumber).toBe(764);
  });

  // ── cenário 4: dependencyLevel vazio quando nulo ────────────────────────────

  it('retorna dependencyLevel vazio quando paciente não tem dependency_level', async () => {
    const row = makePatientRow({ dependencyLevel: '' });
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data as Array<{ dependencyLevel: string }>;
    expect(data[0].dependencyLevel).toBe('');
  });

  // ── cenário 5: shape de resposta preservado ────────────────────────────────

  it('shape de resposta contém exatamente caseNumber, patientId, dependencyLevel', async () => {
    const row = makePatientRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data as unknown[];
    expect(data).toHaveLength(1);
    const item = data[0] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(['caseNumber', 'dependencyLevel', 'patientId'].sort());
  });

  // ── cenário 6: resultado vazio quando nenhum paciente elegível ─────────────

  it('retorna lista vazia quando não há pacientes elegíveis', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  // ── cenário 7: invariante estrutural — SQL parte de patients ───────────────

  it('SQL usa FROM patients (não job_postings) com filtros deleted_at, status, needs_attention', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0] as [string, ...unknown[]];

    expect(sql).toContain('FROM patients p');
    expect(sql).toContain('p.deleted_at IS NULL');
    expect(sql).toContain('p.needs_attention = false');
    expect(sql).toContain("p.status IN ('ACTIVE', 'PENDING_ADMISSION', 'ADMISSION')");
    expect(sql).toContain('p.case_number IS NOT NULL');
    expect(sql).toContain('ORDER BY p.case_number DESC');
    // garante que a query NÃO depende de job_postings para listar casos
    expect(sql).not.toContain('FROM job_postings');
    expect(sql).not.toContain('INNER JOIN');
  });

  // ── cenário 8: 500 em erro de banco ───────────────────────────────────────

  it('retorna 500 quando query lança exceção', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const [req, res] = mockReqRes();
    await controller.getCasesForSelect(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Failed to fetch cases for select',
    });
  });
});
