import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

export interface ResendConfirmDialogProps {
  /** Quantos dos selecionados já receberam a mensagem antes. */
  alreadyCount: number;
  /** Quantos ainda não receberam. */
  newCount: number;
  onResendAll: () => void;
  onNewOnly: () => void;
  onCancel: () => void;
}

/**
 * Decisão síncrona ANTES do envio em background: quando o operador seleciona
 * candidatos que já foram notificados, pergunta se re-envia a todos ou só aos
 * novos. Só a escolha é bloqueante — o envio em si roda no InviteProgressPanel.
 */
export function ResendConfirmDialog({
  alreadyCount,
  newCount,
  onResendAll,
  onNewOnly,
  onCancel,
}: ResendConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-card shadow-xl w-full max-w-lg p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <Heading level={3} weight="semibold" color="secondary">
            {t('admin.messaging.title')}
          </Heading>
          <button
            onClick={onCancel}
            className="text-gray-600 hover:text-red-500 transition-colors"
            aria-label={t('common.close')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-input px-4 py-3">
          <Text size="sm" color="inherit" className="text-amber-800">
            {t('admin.messaging.alreadyReceivedMessage', { count: alreadyCount })}
            {newCount > 0 && (
              <> {t('admin.messaging.notYetReceived', { count: newCount })}</>
            )}{' '}
            {t('admin.messaging.confirmResendQuestion')}
          </Text>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {newCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={onNewOnly}
              className="border-amber-300 text-amber-700 hover:bg-amber-50"
            >
              {t('admin.messaging.newOnly', { count: newCount })}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onResendAll}>
            {t('admin.messaging.resendAll')}
          </Button>
        </div>
      </div>
    </div>
  );
}
