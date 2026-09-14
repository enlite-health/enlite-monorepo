/**
 * PatientPhotoRemoveConfirm — confirmação antes de remover a foto de perfil do paciente (spec
 * 018, PR-4). Molde de `DeactivateProfessionalConfirm.tsx` (mesmo esqueleto de modal já usado
 * na ficha do paciente).
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Trash2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface Props {
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function PatientPhotoRemoveConfirm({ busy, onConfirm, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string) => t(`admin.patients.detail.identityCard.photo.${k}`);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      data-testid="patient-photo-remove-confirm"
    >
      <div className="bg-white rounded-card shadow-xl w-full max-w-md flex flex-col" role="dialog" aria-modal="true" aria-label={tp('removeConfirmTitle')}>
        <div className="flex items-center justify-between p-6 border-b border-gray-200 shrink-0">
          <Heading level={2} weight="semibold" color="primary">{tp('removeConfirmTitle')}</Heading>
          <button onClick={onClose} disabled={busy} className="text-gray-500 hover:text-primary transition-colors" aria-label={t('admin.patients.editDrawer.close')}>
            <X size={24} />
          </button>
        </div>
        <div className="px-6 py-5">
          <Text size="sm" color="inherit">{tp('removeConfirmBody')}</Text>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{tp('removeConfirmCancel')}</Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={busy} data-testid="patient-photo-remove-confirm-button">
            <Trash2 className="w-4 h-4 mr-2" />
            {tp(busy ? 'removeConfirmBusy' : 'removeConfirmYes')}
          </Button>
        </div>
      </div>
    </div>
  );
}
