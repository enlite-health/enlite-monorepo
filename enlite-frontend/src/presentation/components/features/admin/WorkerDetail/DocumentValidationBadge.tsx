import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, X, ShieldCheck } from 'lucide-react';
import type { DocumentValidationEntry } from '@domain/entities/Worker';
import type { AdminDocumentType } from '@hooks/admin/useAdminWorkerDocuments';
import { ConfirmValidationModal } from './ConfirmValidationModal';
import { formatInstant } from '@presentation/utils/dateTimeFormat';

interface DocumentValidationBadgeProps {
  docType: AdminDocumentType;
  validation: DocumentValidationEntry | undefined;
  hasDocument: boolean;
  isLoading: boolean;
  onValidate: (docType: AdminDocumentType) => Promise<void>;
  onInvalidate: (docType: AdminDocumentType) => Promise<void>;
}

function formatValidatedAt(isoDate: string): string {
  return formatInstant(isoDate, { day: 'numeric', month: 'short', year: 'numeric' }) ?? isoDate;
}

export function DocumentValidationBadge({
  docType,
  validation,
  hasDocument,
  isLoading,
  onValidate,
  onInvalidate,
}: DocumentValidationBadgeProps) {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);

  if (!hasDocument) return null;

  if (validation) {
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-green-200 bg-green-50 w-full"
        data-testid={`validation-badge-${docType}`}
      >
        <CheckCircle2
          size={13}
          className="text-green-600 shrink-0"
          aria-hidden="true"
        />
        <span className="text-green-700 text-xs font-medium shrink-0">
          {t('admin.workerDetail.validatedBy')}
        </span>
        <span
          className="text-green-700 text-xs truncate min-w-0 flex-1"
          title={validation.validatedBy}
        >
          {validation.validatedBy}
        </span>
        <span className="text-green-600 text-xs shrink-0 hidden sm:inline">
          · {formatValidatedAt(validation.validatedAt)}
        </span>
        <button
          type="button"
          aria-label={t('admin.workerDetail.removeValidation')}
          disabled={isLoading}
          onClick={() => onInvalidate(docType)}
          className="ml-auto shrink-0 rounded p-0.5 text-green-600 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={isLoading}
        onClick={() => setShowModal(true)}
        data-testid={`validate-btn-${docType}`}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-green-300 text-green-700 text-xs font-medium hover:bg-green-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-fit"
      >
        <ShieldCheck size={13} aria-hidden="true" />
        {t('admin.workerDetail.validateDoc')}
      </button>

      <ConfirmValidationModal
        isOpen={showModal}
        isLoading={isLoading}
        onConfirm={async () => {
          await onValidate(docType);
          setShowModal(false);
        }}
        onCancel={() => setShowModal(false)}
      />
    </>
  );
}
