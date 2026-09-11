/**
 * pendingRows.test.ts
 *
 * Fase 4 de postulacao-documento-pendente (DD5): `buildPendingRows` é a
 * função PURA extraída de `PendingTasksCard` — a MESMA que
 * `JobsEmbeddedSection` usa pro rótulo do botão "Postularse", pra nunca
 * mais divergir a contagem entre os dois lugares (achado do gate,
 * correção b do orquestrador, 11/09).
 *
 * Casos espelham os do gate na Fase 2 (BLOCKER 1, A-E) — mesma fonte de
 * verdade, agora testada uma vez só nesta função.
 */
import { describe, it, expect } from 'vitest';
import { buildPendingRows } from '../pendingRows';

describe('buildPendingRows', () => {
  it('missingFields vazio → nenhuma linha', () => {
    expect(buildPendingRows([], 'CAREGIVER')).toEqual([]);
  });

  it('caso feliz — AT só sem antecedentes: 1 linha de documento', () => {
    const rows = buildPendingRows(['doc_criminal_record'], 'AT');
    expect(rows).toEqual([{ key: 'doc_criminal_record', kind: 'document', token: 'doc_criminal_record' }]);
  });

  it('registro (phone) + documento (doc_criminal_record) → registro ANTES do documento (ordem DD2)', () => {
    const rows = buildPendingRows(['doc_criminal_record', 'phone'], 'CAREGIVER');
    expect(rows).toEqual([
      { key: 'general', kind: 'registration', tab: 'general' },
      { key: 'doc_criminal_record', kind: 'document', token: 'doc_criminal_record' },
    ]);
  });

  it('2+ tokens na MESMA aba de registro colapsam em UMA linha', () => {
    const rows = buildPendingRows(['phone', 'first_name'], 'CAREGIVER');
    expect(rows).toEqual([{ key: 'general', kind: 'registration', tab: 'general' }]);
  });

  it('documentos na ordem da política F5, independente da ordem em missingFields', () => {
    const rows = buildPendingRows(['doc_criminal_record', 'doc_identity_document'], 'CAREGIVER');
    expect(rows.map((r) => r.key)).toEqual(['doc_identity_document', 'doc_criminal_record']);
  });

  it('caso B do gate — profissão NULL com CV e certificado pendentes: NULL tratado como AT (paridade com o portão)', () => {
    const rows = buildPendingRows(['profession', 'doc_resume_cv', 'doc_at_certificate'], null);
    expect(rows).toEqual([
      { key: 'general', kind: 'registration', tab: 'general' },
      { key: 'doc_resume_cv', kind: 'document', token: 'doc_resume_cv' },
      { key: 'doc_at_certificate', kind: 'document', token: 'doc_at_certificate' },
    ]);
  });

  it('caso C do gate — cadastro novo CAREGIVER: 3 linhas de registro + 2 de documento = 5, não 18', () => {
    const generalTokens = [
      'first_name', 'last_name', 'sex', 'gender', 'birth_date', 'document_number',
      'phone', 'languages', 'profession', 'knowledge_level', 'title_certificate',
      'years_experience', 'experience_types', 'preferred_types',
    ];
    const rows = buildPendingRows(
      [...generalTokens, 'worker_service_areas', 'worker_availability', 'doc_identity_document', 'doc_criminal_record'],
      'CAREGIVER',
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.kind)).toEqual(['registration', 'registration', 'registration', 'document', 'document']);
  });

  it('caso D do gate — token cru worker_documents: 1 linha genérica, não sabemos qual documento', () => {
    const rows = buildPendingRows(['worker_documents'], 'CAREGIVER');
    expect(rows).toEqual([{ key: 'documents-generic', kind: 'document-generic' }]);
  });

  it('caso E do gate — CAREGIVER com doc_resume_cv pendente (servidor pede doc que a política local de Cuidador não exige): 1 linha, NUNCA filtrada', () => {
    const rows = buildPendingRows(['doc_resume_cv'], 'CAREGIVER');
    expect(rows).toEqual([{ key: 'doc_resume_cv', kind: 'document', token: 'doc_resume_cv' }]);
  });

  it('é uma função PURA — mesmo input produz o mesmo output, sem efeito colateral', () => {
    const input = ['phone', 'doc_criminal_record'];
    const first = buildPendingRows(input, 'AT');
    const second = buildPendingRows(input, 'AT');
    expect(first).toEqual(second);
    expect(input).toEqual(['phone', 'doc_criminal_record']); // input não mutado
  });
});
