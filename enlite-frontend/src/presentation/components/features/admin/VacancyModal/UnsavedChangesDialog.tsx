/**
 * UnsavedChangesDialog
 *
 * Confirmação de saída com alteração não gravada — fase 4 (`completar-vacante-em-rascunho`, F27).
 * UMA confirmação, mesmo texto em todo ponto de saída coberto por `useUnsavedChangesGuard`.
 * Mesmo molde de `ResumeDraftVacancyDialog`/`AddressHasVacancyDialog` (já na casa): overlay +
 * `role="dialog"` + Escape fecha.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';

export interface UnsavedChangesDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UnsavedChangesDialog({
  isOpen,
  onConfirm,
  onCancel,
}: UnsavedChangesDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const k = (key: string) => t(`admin.createVacancyV2.unsavedChangesDialog.${key}`);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      data-testid="unsaved-changes-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-[10px] p-6 max-w-md w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-amber-50">
            <AlertTriangle size={20} className="text-amber-600" aria-hidden="true" />
          </div>
          <Heading level={3} id="unsaved-changes-title" weight="semibold" color="primary">
            {k('title')}
          </Heading>
        </div>

        <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-3">
          <Button variant="ghost" size="sm" data-testid="unsaved-changes-cancel" onClick={onCancel}>
            {k('cancel')}
          </Button>
          <Button variant="primary" size="sm" data-testid="unsaved-changes-confirm" onClick={onConfirm}>
            {k('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
