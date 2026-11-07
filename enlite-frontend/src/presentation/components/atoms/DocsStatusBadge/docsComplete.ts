const COMPLETE_STATUSES = new Set<string>(['approved', 'submitted', 'under_review']);

/**
 * Dono único da regra "documentação completa" (DF-16): `documents_status` ∈ {approved, submitted,
 * under_review}. Nulo/desconhecido/sem linha em worker_documents = incompleto. Quem precisa da regra
 * sem renderizar (ex.: modelo da página Invitar prestadores) importa esta função — não reescreve.
 */
export function isDocsComplete(status: string | null | undefined): boolean {
  if (!status) return false;
  return COMPLETE_STATUSES.has(status.toLowerCase());
}
