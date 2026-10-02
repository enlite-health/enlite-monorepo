/**
 * DeletePatientDocumentConfirm — confirmação antes de EXCLUIR um documento do paciente (spec 031,
 * FR-014; a exclusão é definitiva). Molde: `DeactivateProfessionalConfirm.tsx`, com uma diferença
 * que é requisito: o foco inicial vai para "Cancelar" — Enter/espaço logo ao abrir nunca exclui.
 * Esc e clique no fundo fecham (exceto durante a exclusão).
 *
 * O nome do documento é texto digitado pela operadora: `data-clarity-mask` no nó que o desenha.
 */
import { useEffect, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface Props {
  name: string;
  busy: boolean;
  /** Mensagem de falha da exclusão (já traduzida), mostrada dentro do diálogo. */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeletePatientDocumentConfirm({ name, busy, error, onConfirm, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const td = (k: string): string => t(`admin.patients.detail.documentsTab.${k}`);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      data-testid="patient-document-delete-confirm"
    >
      <div
        className="bg-white rounded-card shadow-xl w-full max-w-md flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="patient-document-delete-title"
      >
        <div className="flex items-start justify-between gap-3 p-6 border-b border-gray-600 shrink-0">
          <Heading level={2} weight="semibold" color="primary" id="patient-document-delete-title" className="min-w-0 break-words">
            {td('deleteConfirmOpen')}
            <span data-clarity-mask="True" data-testid="patient-document-delete-name">{name}</span>
            {td('deleteConfirmClose')}
          </Heading>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-gray-800 hover:text-primary transition-colors shrink-0"
            aria-label={t('admin.patients.editDrawer.close')}
          >
            <X size={24} />
          </button>
        </div>
        <div className="px-6 py-5 flex flex-col gap-2">
          <Text size="sm" color="inherit">{td('deleteConfirmBody')}</Text>
          {error && (
            <Text size="sm" role="alert" className="text-red-800" data-testid="patient-document-delete-error">{error}</Text>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-600 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={busy}
            autoFocus
            data-testid="patient-document-delete-cancel"
          >
            {td('deleteConfirmCancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            data-testid="patient-document-delete-yes"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            {td(busy ? 'deleteConfirmBusy' : 'deleteConfirmYes')}
          </Button>
        </div>
      </div>
    </div>
  );
}
