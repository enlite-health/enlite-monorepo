import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';

/**
 * DocsStatusBadge
 *
 * Pill que mostra o status de documentação de um worker.
 * Reutilizado em:
 *   - Lista de workers (WorkersTable) — passa `complete` (boolean derivado) + `status`.
 *   - Lista de match (MatchCandidateRow) — passa só o `status` cru de
 *     worker_documents.documents_status ('pending' | 'incomplete' | 'submitted' |
 *     'under_review' | 'approved' | 'rejected'), ou null.
 *
 * Regra de cor:
 *   - verde (completo) quando `complete === true`, ou quando `complete` não é
 *     informado e o status cru representa documentação concluída
 *     ('approved' | 'submitted' | 'under_review').
 *   - vermelho caso contrário.
 *
 * i18n: reusa as chaves existentes em `admin.workers.docsStatus.*`.
 * Status null/desconhecido renderiza '—' (sem pill).
 */

type DocumentsStatus =
  | 'pending'
  | 'incomplete'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected';

interface DocsStatusBadgeProps {
  /** Status cru de worker_documents.documents_status, ou null/undefined se não existir registro. */
  status: string | null | undefined;
  /**
   * Override explícito de "documentação completa" (verde). Quando omitido, a
   * completude é derivada do próprio `status`.
   */
  complete?: boolean;
}

const COMPLETE_STATUSES = new Set<DocumentsStatus>(['approved', 'submitted', 'under_review']);

const STATUS_I18N_KEY: Record<DocumentsStatus, string> = {
  pending: 'admin.workers.docsStatus.pending',
  incomplete: 'admin.workers.docsStatus.incomplete',
  submitted: 'admin.workers.docsStatus.submitted',
  under_review: 'admin.workers.docsStatus.under_review',
  approved: 'admin.workers.docsStatus.approved',
  rejected: 'admin.workers.docsStatus.rejected',
};

function isDocumentsStatus(value: string): value is DocumentsStatus {
  return value in STATUS_I18N_KEY;
}

export function DocsStatusBadge({ status, complete }: DocsStatusBadgeProps): JSX.Element {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Text as="span" size="xs" color="muted">
        —
      </Text>
    );
  }

  const normalized = status.toLowerCase();
  const isComplete =
    complete ?? (isDocumentsStatus(normalized) && COMPLETE_STATUSES.has(normalized));

  const label =
    complete === true
      ? t('admin.workers.docsStatus.complete')
      : isDocumentsStatus(normalized)
        ? t(STATUS_I18N_KEY[normalized])
        : t('admin.workers.docsStatus.incomplete', { defaultValue: status });

  if (isComplete) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-green-100 text-green-700">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        <Text as="span" size="xs" weight="medium" color="inherit">
          {label}
        </Text>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-red-100 text-red-700">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
      <Text as="span" size="xs" weight="medium" color="inherit">
        {label}
      </Text>
    </span>
  );
}
