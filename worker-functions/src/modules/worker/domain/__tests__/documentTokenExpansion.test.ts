/**
 * documentTokenExpansion.test.ts
 *
 * Ponto único de expansão `worker_documents` → `doc_*` (F13/DD1 —
 * openspec/changes/postulacao-documento-pendente). Extraído de
 * `BlockedApplicationRepository.expandDocumentToken` para ser reusado, sem
 * duplicar a regra F5, pelo `GET /api/workers/me` (via
 * `WorkerCompletenessRepository.readWorkerMissingFields`) e pelo 403 do
 * track-channel (via `BlockedApplicationRepository.upsert`).
 *
 * Função PURA — sem I/O. A busca da linha (profissão + `worker_documents`) é
 * responsabilidade de quem chama (`fetchWorkerDocumentRow`).
 */

import { expandDocumentToken, type WorkerDocumentRow } from '../documentTokenExpansion';

const rowAT = (overrides: Partial<WorkerDocumentRow> = {}): WorkerDocumentRow => ({
  profession: 'AT',
  resume_cv_url: 'url',
  identity_document_url: 'url',
  criminal_record_url: 'url',
  at_certificate_url: 'url',
  ...overrides,
});

describe('expandDocumentToken', () => {
  it('worker_documents ausente dos missingFields → devolve o array intacto (sem tocar em documentos)', () => {
    const missing = ['phone', 'title_certificate'];
    expect(expandDocumentToken(missing, rowAT())).toBe(missing); // mesma referência: nem copia à toa
  });

  it('AT faltando só at_certificate → doc_at_certificate', () => {
    const result = expandDocumentToken(['worker_documents'], rowAT({ at_certificate_url: null }));
    expect(result).toEqual(['doc_at_certificate']);
  });

  it('CUIDADOR sem DNI → doc_identity_document, sem doc_at_certificate nem doc_resume_cv (não obrigatórios)', () => {
    const result = expandDocumentToken(['worker_documents'], {
      profession: 'CAREGIVER',
      resume_cv_url: null,
      identity_document_url: null,
      criminal_record_url: 'url',
      at_certificate_url: null,
    });
    expect(result).toEqual(['doc_identity_document']);
  });

  it('profession NULL → tratado como AT (paridade com fn_worker_missing_fields: NULL != \'AT\' é NULL, não TRUE)', () => {
    const result = expandDocumentToken(['worker_documents'], {
      profession: null,
      resume_cv_url: null,
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: null,
    });
    expect(result).toContain('doc_resume_cv');
    expect(result).toContain('doc_at_certificate');
    expect(result).not.toContain('doc_identity_document');
    expect(result).not.toContain('doc_criminal_record');
  });

  it('profession vazia ("") → mesmo tratamento de NULL (AT)', () => {
    const result = expandDocumentToken(['worker_documents'], rowAT({ profession: '', resume_cv_url: null }));
    expect(result).toContain('doc_resume_cv');
  });

  it('todos os docs faltando para AT → os 4 tokens doc_*, nesta ordem (DNI, antecedentes, CV, cert AT)', () => {
    const result = expandDocumentToken(['worker_documents'], {
      profession: 'AT',
      resume_cv_url: null,
      identity_document_url: null,
      criminal_record_url: null,
      at_certificate_url: null,
    });
    expect(result).toEqual([
      'doc_identity_document',
      'doc_criminal_record',
      'doc_resume_cv',
      'doc_at_certificate',
    ]);
  });

  it('todos os docs presentes → [] (worker_documents removido, nenhum doc_* entra)', () => {
    expect(expandDocumentToken(['worker_documents'], rowAT())).toEqual([]);
  });

  it('preserva os demais tokens do array e remove só worker_documents', () => {
    const result = expandDocumentToken(
      ['title_certificate', 'worker_documents'],
      rowAT({ resume_cv_url: null }),
    );
    expect(result).toContain('title_certificate');
    expect(result).toContain('doc_resume_cv');
    expect(result).not.toContain('worker_documents');
  });

  it('row null (worker não encontrado ou merge órfão) → devolve missingFields sem expandir, fail-safe', () => {
    const missing = ['worker_documents'];
    expect(expandDocumentToken(missing, null)).toEqual(['worker_documents']);
  });
});
