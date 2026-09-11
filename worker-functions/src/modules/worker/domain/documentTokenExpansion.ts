/**
 * documentTokenExpansion.ts
 *
 * Ponto ÚNICO de expansão do token grosso `worker_documents` (como
 * `fn_worker_missing_fields` o devolve) para os tokens específicos `doc_*`.
 *
 * Extraído de `BlockedApplicationRepository.expandDocumentToken` (que só o 403
 * da postulação usava — F3) para que `GET /api/workers/me` e a resposta do
 * `PUT` de info geral devolvam o MESMO detalhe, sem copiar a regra F5
 * (openspec/changes/postulacao-documento-pendente/design.md, DD1).
 *
 * Função PURA — sem I/O. Quem chama busca a linha (profissão + URLs de
 * `worker_documents`) via `fetchWorkerDocumentRow` (WorkerCompletenessRepository.ts)
 * e passa aqui.
 *
 * ⚠️ NÃO troque por `workerDocumentPolicy.ts` — divergência PROPOSITAL:
 * `workerDocumentPolicy.classifyProfession` trata profissão NULL/'' como
 * CUIDADOR (conjunto base). O gate SQL (`fn_worker_missing_fields`, migration
 * 212) faz `profession != 'AT'`, que em NULL avalia NULL (nem TRUE nem FALSE)
 * — então o OR só passa quando `resume_cv` E `at_certificate` estão
 * presentes, ou seja, profissão desconhecida é tratada como AT. Este módulo
 * espelha o SQL, não o helper TS — paridade com o portão é requisito
 * explícito (ver teste "profession NULL → tratado como AT").
 */

export interface WorkerDocumentRow {
  profession: string | null;
  resume_cv_url: string | null;
  identity_document_url: string | null;
  criminal_record_url: string | null;
  at_certificate_url: string | null;
}

type DocColumn = keyof Omit<WorkerDocumentRow, 'profession'>;

/** Maps worker_documents SQL column names to their doc_* tokens. */
const DOC_COLUMN_TO_TOKEN: Record<DocColumn, string> = {
  identity_document_url: 'doc_identity_document',
  criminal_record_url: 'doc_criminal_record',
  resume_cv_url: 'doc_resume_cv',
  at_certificate_url: 'doc_at_certificate',
};

const BASE_COLUMNS: readonly DocColumn[] = ['identity_document_url', 'criminal_record_url'];
const AT_EXTRA_COLUMNS: readonly DocColumn[] = ['resume_cv_url', 'at_certificate_url'];

/**
 * Expande o token grosso `worker_documents` para os tokens `doc_*`
 * específicos que faltam, na ordem DNI → antecedentes → CV → certificado AT.
 *
 * Se `worker_documents` não estiver em `missingFields`, devolve o array
 * INTACTO (mesma referência) — nada de documentos para expandir.
 *
 * `row === null` (worker não encontrado, ou merge órfão) é fail-safe: devolve
 * `missingFields` sem expandir, para o chamador decidir o fallback (o 403
 * mantém o token cru; ver `BlockedApplicationRepository`).
 */
export function expandDocumentToken(
  missingFields: string[],
  row: WorkerDocumentRow | null,
): string[] {
  if (!missingFields.includes('worker_documents')) {
    return missingFields;
  }
  if (row === null) {
    return missingFields;
  }

  // Semântica de profession IS NULL: espelha EXATAMENTE o gate SQL
  // fn_worker_missing_fields (migration 212). Ver aviso no topo do arquivo.
  const isAtOrUnknown = row.profession === 'AT' || row.profession === null || row.profession === '';
  const requiredColumns = isAtOrUnknown ? [...BASE_COLUMNS, ...AT_EXTRA_COLUMNS] : BASE_COLUMNS;

  const missingDocTokens = requiredColumns
    .filter((col) => row[col] === null)
    .map((col) => DOC_COLUMN_TO_TOKEN[col]);

  return missingFields.filter((f) => f !== 'worker_documents').concat(missingDocTokens);
}
