/**
 * BlockedApplicationRepository.test.ts
 *
 * Testes unitários do repositório de escrita de tentativas bloqueadas.
 *
 * Cenários:
 * 1. Upsert (insertion) — reason=registration_incomplete: chama fn_worker_missing_fields + INSERT
 * 2. Upsert — reason=worker_not_found: também chama fn_worker_missing_fields
 * 3. Upsert — reason=worker_disabled: NÃO chama fn_worker_missing_fields, missing_fields=[]
 * 4. Falha no SELECT da função SQL — loga warn mas não re-lança
 * 5. Falha no INSERT — propaga erro
 * 6. missingFields = array retornado pela função SQL é serializado corretamente
 * 7. expandDocumentToken: AT faltando at_certificate → doc_at_certificate
 * 8. expandDocumentToken: CUIDADOR sem DNI → doc_identity_document (sem doc_at_certificate)
 * 9. expandDocumentToken: profession NULL → trata como AT (resume_cv + at_certificate obrigatórios)
 * 10. expandDocumentToken: worker_documents ausente dos missing_fields → sem expansão
 * 11. title_certificate aparece em missingFields sem afetar doc expansion
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

const mockLoggerChild = jest.fn().mockReturnValue({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});
const mockLoggerWarn = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: {
    child: mockLoggerChild,
    warn: mockLoggerWarn,
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { BlockedApplicationRepository } from '../BlockedApplicationRepository';

const WORKER_ID = 'aabbccdd-0000-0000-0000-111111111111';
const JOB_ID    = 'bbccddee-0000-0000-0000-222222222222';

/**
 * Helper: mocks the three DB calls for upsert when worker_documents is in missingFields.
 * 1. fn_worker_missing_fields → returns missingFieldsJson
 * 2. INSERT ... ON CONFLICT
 * 3. SELECT for expandDocumentToken
 */
function mockUpsertWithDocExpand(
  missingFieldsJson: string,
  expandRow: {
    profession: string | null;
    resume_cv_url: string | null;
    identity_document_url: string | null;
    criminal_record_url: string | null;
    at_certificate_url: string | null;
  },
): void {
  mockQuery.mockResolvedValueOnce({ rows: [{ missing: missingFieldsJson }] }); // fn_worker_missing_fields
  mockQuery.mockResolvedValueOnce({ rowCount: 1 });                            // INSERT
  mockQuery.mockResolvedValueOnce({ rows: [expandRow] });                      // expandDocumentToken SELECT
}

/**
 * Helper: mocks upsert when worker_documents is NOT in missingFields (no expand query).
 */
function mockUpsertNoExpand(missingFieldsJson: string): void {
  mockQuery.mockResolvedValueOnce({ rows: [{ missing: missingFieldsJson }] }); // fn_worker_missing_fields
  mockQuery.mockResolvedValueOnce({ rowCount: 1 });                            // INSERT
  // No expand query — worker_documents not in missingFields
}

describe('BlockedApplicationRepository', () => {
  let repo: BlockedApplicationRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new BlockedApplicationRepository();
  });

  it('chama fn_worker_missing_fields e depois INSERT para reason=registration_incomplete', async () => {
    // No worker_documents token → no expand query
    mockUpsertNoExpand('["first_name","phone"]');

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: 'facebook',
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Primeira chamada: SELECT fn_worker_missing_fields
    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall[0]).toContain('fn_worker_missing_fields');
    expect(selectCall[1]).toEqual([WORKER_ID]);

    // Segunda chamada: INSERT ... ON CONFLICT
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO worker_blocked_applications');
    expect(insertCall[0]).toContain('ON CONFLICT (worker_id, job_posting_id)');
    expect(insertCall[1][2]).toBe('registration_incomplete');
    expect(insertCall[1][3]).toBe('["first_name","phone"]');
    expect(insertCall[1][4]).toBe('facebook');

    // Retorno: missingFields sem expansão (sem worker_documents)
    expect(result).toEqual(['first_name', 'phone']);
  });

  it('chama fn_worker_missing_fields para reason=worker_not_found', async () => {
    mockUpsertNoExpand('["worker_not_found"]');

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_not_found',
      acquisitionChannel: null,
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain('fn_worker_missing_fields');
    expect(result).toEqual(['worker_not_found']);
  });

  it('NÃO chama fn_worker_missing_fields para reason=worker_disabled — missing_fields=[]', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_disabled',
      acquisitionChannel: 'instagram',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO worker_blocked_applications');
    // missing_fields deve ser array vazio serializado
    expect(insertCall[1][3]).toBe('[]');
    expect(result).toEqual([]);
  });

  it('missing_fields = [] quando fn_worker_missing_fields retorna resultado inesperado', async () => {
    // Retorna undefined (campo ausente)
    mockQuery.mockResolvedValueOnce({ rows: [{}] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1][3]).toBe('[]');
    expect(result).toEqual([]);
  });

  it('loga warn mas não propaga quando fn_worker_missing_fields retorna JSON inválido', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: 'not-json' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      repo.upsert({
        workerId: WORKER_ID,
        jobPostingId: JOB_ID,
        reason: 'registration_incomplete',
        acquisitionChannel: null,
      }),
    ).resolves.toEqual([]);

    const childLogger = mockLoggerChild.mock.results[0]?.value;
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('failed to parse') }),
    );
  });

  it('propaga erro quando o INSERT falha', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '[]' }] });
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(
      repo.upsert({
        workerId: WORKER_ID,
        jobPostingId: JOB_ID,
        reason: 'registration_incomplete',
        acquisitionChannel: null,
      }),
    ).rejects.toThrow('DB connection lost');
  });

  it('serializa array de missing_fields como JSON string no INSERT (inclui worker_documents cru)', async () => {
    const fields = ['first_name', 'worker_availability', 'worker_documents'];
    mockUpsertWithDocExpand(JSON.stringify(fields), {
      profession: 'AT',
      resume_cv_url: 'url',
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: null, // AT faltando at_certificate
    });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: 'whatsapp',
    });

    const insertCall = mockQuery.mock.calls[1];
    // O banco grava o array cru (com worker_documents)
    expect(JSON.parse(insertCall[1][3] as string)).toEqual(fields);
  });

  it('aceita missing quando fn retorna array JS (não string) — branch else if Array.isArray', async () => {
    // Cobre linhas: `else if (Array.isArray(raw))` — pg pode retornar JSONB já parseado
    const fields = ['first_name', 'phone'];
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: fields }] }); // já é array
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(JSON.parse(insertCall[1][3] as string)).toEqual(fields);
    expect(result).toEqual(fields);
  });

  it('filtra valores não-string do array retornado pela fn', async () => {
    // Cobre o filter dentro do else if Array.isArray: (v) => typeof v === 'string'
    const mixed = ['first_name', 42, null, 'phone'];
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: mixed }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(JSON.parse(insertCall[1][3] as string)).toEqual(['first_name', 'phone']);
    expect(result).toEqual(['first_name', 'phone']);
  });

  // ── expandDocumentToken ────────────────────────────────────────────────────

  it('AT faltando at_certificate → retorna doc_at_certificate', async () => {
    mockUpsertWithDocExpand('["worker_documents"]', {
      profession: 'AT',
      resume_cv_url: 'url',
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: null,
    });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    expect(result).toEqual(['doc_at_certificate']);
  });

  it('CUIDADOR sem DNI → doc_identity_document, sem doc_at_certificate', async () => {
    mockUpsertWithDocExpand('["worker_documents"]', {
      profession: 'CAREGIVER',
      resume_cv_url: null,      // não obrigatório para CUIDADOR
      identity_document_url: null,
      criminal_record_url: 'url',
      at_certificate_url: null, // não obrigatório para CUIDADOR
    });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    expect(result).toEqual(['doc_identity_document']);
    expect(result).not.toContain('doc_at_certificate');
    expect(result).not.toContain('doc_resume_cv');
  });

  it('profession NULL → trata como AT (resume_cv + at_certificate obrigatórios)', async () => {
    // Espelha SQL: NULL != \'AT\' = NULL → OR só passa se resume_cv+at_certificate presentes
    mockUpsertWithDocExpand('["worker_documents"]', {
      profession: null,
      resume_cv_url: null,
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: null,
    });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    expect(result).toContain('doc_resume_cv');
    expect(result).toContain('doc_at_certificate');
    expect(result).not.toContain('doc_identity_document');
    expect(result).not.toContain('doc_criminal_record');
  });

  it('worker_documents ausente dos missing_fields → sem query de expansão', async () => {
    // worker_documents NÃO está em missingFields → expandDocumentToken não faz query
    mockUpsertNoExpand('["title_certificate","phone"]');

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    // Apenas fn_worker_missing_fields + INSERT (2 queries, sem expand)
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(result).toEqual(['title_certificate', 'phone']);
  });

  it('title_certificate aparece em missingFields sem afetar doc expansion', async () => {
    mockUpsertWithDocExpand('["title_certificate","worker_documents"]', {
      profession: 'AT',
      resume_cv_url: null,
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: 'url',
    });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    expect(result).toContain('title_certificate');
    expect(result).toContain('doc_resume_cv');
    expect(result).not.toContain('worker_documents');
  });

  it('todos os docs faltando para AT → retorna todos os 4 tokens doc_*', async () => {
    mockUpsertWithDocExpand('["worker_documents"]', {
      profession: 'AT',
      resume_cv_url: null,
      identity_document_url: null,
      criminal_record_url: null,
      at_certificate_url: null,
    });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    expect(result).toEqual(expect.arrayContaining([
      'doc_resume_cv',
      'doc_identity_document',
      'doc_criminal_record',
      'doc_at_certificate',
    ]));
    expect(result).toHaveLength(4);
  });

  it('todos os docs presentes para AT → sem tokens doc_*', async () => {
    mockUpsertWithDocExpand('["worker_documents"]', {
      profession: 'AT',
      resume_cv_url: 'url',
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: 'url',
    });

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    // worker_documents estava na lista mas todos os docs estão presentes
    expect(result).toEqual([]);
  });

  it('expandDocumentToken: worker não encontrado → retorna missingFields sem expansão', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["worker_documents"]' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // worker not found in expand query

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    // Fallback: mantém o token cru
    expect(result).toEqual(['worker_documents']);
  });

  it('expandDocumentToken: falha na query → loga warn e retorna missingFields sem expansão', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["worker_documents"]' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockRejectedValueOnce(new Error('expand query failed'));

    const result = await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    // Fallback gracioso: retorna token cru sem lançar
    expect(result).toEqual(['worker_documents']);
    const childLogger = mockLoggerChild.mock.results[0]?.value;
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('expandDocumentToken') }),
    );
  });
});
