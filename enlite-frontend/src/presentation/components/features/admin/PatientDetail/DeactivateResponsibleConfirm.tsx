/**
 * DeactivateResponsibleConfirm — confirmação antes de desativar um familiar da rede de apoio
 * (nunca DELETE — FR-002/C8). Mesmo molde de `DeactivateProfessionalConfirm.tsx`.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Trash2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface Props {
  name: string;
  busy: boolean;
  /** Mensagem genérica quando a desativação falhou (nunca eco de payload — lex C1.3). */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeactivateResponsibleConfirm({ name, busy, error, onConfirm, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.detail.familyCard.${k}`);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      data-testid="deactivate-responsible-confirm"
    >
      <div className="bg-white rounded-card shadow-xl w-full max-w-md flex flex-col" role="dialog" aria-modal="true" aria-label={tc('deactivateConfirmTitle')}>
        <div className="flex items-center justify-between p-6 border-b border-gray-200 shrink-0">
          <Heading level={2} weight="semibold" color="primary">{tc('deactivateConfirmTitle')}</Heading>
          <button onClick={onClose} disabled={busy} className="text-gray-500 hover:text-primary transition-colors" aria-label={t('admin.patients.editDrawer.close')}>
            <X size={24} />
          </button>
        </div>
        <div className="px-6 py-5 flex flex-col gap-2">
          <Text size="sm" color="inherit">{tc('deactivateConfirmBody')}</Text>
          <Text size="sm" weight="semibold" data-testid="deactivate-responsible-name">{name}</Text>
          {error && <Text size="sm" className="text-red-600" data-testid="deactivate-responsible-error">{error}</Text>}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{tc('deactivateConfirmCancel')}</Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={busy} data-testid="deactivate-responsible-confirm-button">
            <Trash2 className="w-4 h-4 mr-2" />
            {tc(busy ? 'deactivateConfirmBusy' : 'deactivateConfirmYes')}
          </Button>
        </div>
      </div>
    </div>
  );
}
