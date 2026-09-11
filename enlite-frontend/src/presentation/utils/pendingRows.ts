import { destinationFor, TAB_ORDER, type TabId } from '@presentation/utils/incompleteFieldDestinations';
import { requiredDocTypesFor } from '@presentation/utils/workerDocumentPolicy';

/** Ordem de registro (DD2): `TAB_ORDER` sem 'documents' — general → address → availability. */
export const REGISTRATION_TAB_ORDER: readonly TabId[] = TAB_ORDER.filter((tab) => tab !== 'documents');

export type PendingRowKind = 'registration' | 'document' | 'document-generic';

export interface PendingRow {
  key: string;
  kind: PendingRowKind;
  /** Presente só quando `kind === 'registration'`. */
  tab?: TabId;
  /** Presente só quando `kind === 'document'` (token `doc_*` específico). */
  token?: string;
}

/**
 * Monta as linhas de pendência a partir de `missingFields` (F1/DD1) —
 * função PURA (sem `t()`, sem JSX), extraída de `PendingTasksCard` na
 * Fase 4 (DD5) porque o rótulo do botão "Postularse" no card da vaga
 * (`JobsEmbeddedSection`) precisa do MESMO número de pendências (N) que a
 * lista de tarefas mostra — antes da extração, cada lugar contava por
 * conta própria, e uma segunda contagem diverge cedo ou tarde (foi
 * exatamente essa classe de bug que os gates da Fase 2/3 pegaram dentro
 * do próprio `PendingTasksCard`, entre o título e o "X de Y").
 *
 * Regras (mesmas do `PendingTasksCard`, F5):
 * - Registro: um token por ABA (general/address/availability), agrupado —
 *   2 campos pendentes na mesma aba viram 1 linha só.
 * - Documento: um token por `doc_*` ESPECÍFICO, na ordem da política de
 *   PARIDADE COM O PORTÃO (`workerDocumentPolicy.requiredDocTypesFor`,
 *   NULL/'' tratado como AT — mesma paridade do SQL gate), seguido de
 *   qualquer `doc_*` EXTRA que o servidor pediu e a política local não
 *   conhece (nunca filtra a pendência do servidor — F1/DD1).
 * - `worker_documents` cru (fallback da Fase 1 quando a expansão por
 *   documento falha): vira UMA linha genérica — não dá pra saber qual
 *   documento falta.
 */
export function buildPendingRows(missingFields: string[], profession?: string | null): PendingRow[] {
  const registrationTokens = missingFields.filter((token) => destinationFor(token).tab !== 'documents');
  const documentsTokens = missingFields.filter((token) => destinationFor(token).tab === 'documents');

  const pendingTabsSet = new Set<TabId>(registrationTokens.map((token) => destinationFor(token).tab));
  const registrationRows: PendingRow[] = REGISTRATION_TAB_ORDER.filter((tab) => pendingTabsSet.has(tab)).map(
    (tab) => ({ key: tab, kind: 'registration', tab }),
  );

  const requiredDocTokens = requiredDocTypesFor(profession).map((docType) => `doc_${docType}`);
  const hasGenericDocToken = documentsTokens.some((token) => !token.startsWith('doc_'));

  const documentRows: PendingRow[] = hasGenericDocToken
    ? [{ key: 'documents-generic', kind: 'document-generic' }]
    : [
        ...requiredDocTokens.filter((token) => documentsTokens.includes(token)),
        ...documentsTokens.filter((token) => !requiredDocTokens.includes(token)),
      ].map((token) => ({ key: token, kind: 'document', token }));

  return [...registrationRows, ...documentRows];
}
