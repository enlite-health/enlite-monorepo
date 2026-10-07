import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface Props {
  onCancel: () => void;
  onConfirm: () => void;
  /** `true` enquanto o DELETE está em voo: trava os dois botões e mostra o spinner no de confirmar. */
  busy?: boolean;
}

/**
 * Spec 044 (D4): confirmação de EXCLUSÃO de uma Localización. A remoção é definitiva (DELETE físico),
 * então a pergunta é obrigatória — e é um diálogo do design system, nunca `window.confirm`. Mesmos átomos
 * e a mesma moldura do `DiscardChangesConfirm` (que confirma "perder trabalho"); não reaproveita aquele
 * porque os textos e os botões são de outra ação. Sem texto de endereço aqui: o diálogo não repete o dado.
 */
export function DeleteAddressConfirm({ onCancel, onConfirm, busy = false }: Props): JSX.Element {
  const { t } = useTranslation();
  const tl = (k: string) => t(`admin.patients.detail.locationsCard.${k}`);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={tl('deleteConfirmTitle')}
      data-testid="delete-address-confirm"
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 flex flex-col gap-4">
        <Heading level={4} weight="semibold" color="primary">{tl('deleteConfirmTitle')}</Heading>
        <Text size="sm" color="secondary">{tl('deleteConfirmBody')}</Text>
        <div className="flex justify-end gap-3 mt-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy} data-testid="delete-address-cancel">
            {tl('deleteConfirmCancel')}
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={onConfirm} isLoading={busy} data-testid="delete-address-confirm-btn">
            {tl('deleteConfirmAction')}
          </Button>
        </div>
      </div>
    </div>
  );
}
