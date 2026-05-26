import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useMatchMessaging } from '@hooks/admin/useMatchMessaging';
import type { InviteTarget } from './inviteTypes';

export interface InviteProgressModalProps {
  candidates: InviteTarget[];
  vacancyId: string;
  onClose: () => void;
  onMessaged: (workerId: string, messagedAt: string) => void;
}

type RenotifyChoice = 'all' | 'new-only' | null;

export function InviteProgressModal({
  candidates,
  vacancyId,
  onClose,
  onMessaged,
}: InviteProgressModalProps) {
  const { t } = useTranslation();
  const { isSending, progress, sendBatch, resetProgress } = useMatchMessaging(vacancyId);

  const alreadyNotified = candidates.filter(c => c.messagedAt != null);
  const notYetNotified  = candidates.filter(c => c.messagedAt == null);

  // null = ainda não escolheu; só relevante quando há candidatos já notificados
  const [renotifyChoice, setRenotifyChoice] = useState<RenotifyChoice>(null);

  const started = progress.length > 0;
  const done    = started && !isSending;
  const sentCount  = progress.filter(p => p.status === 'sent').length;
  const errorCount = progress.filter(p => p.status === 'error').length;

  // Se ninguém está notificado, dispara direto ao montar
  useEffect(() => {
    if (alreadyNotified.length === 0) {
      sendBatch(candidates, onMessaged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quando o operador escolhe "re-enviar a todos" ou "só os novos"
  useEffect(() => {
    if (renotifyChoice === 'all') {
      sendBatch(candidates, onMessaged);
    } else if (renotifyChoice === 'new-only') {
      sendBatch(notYetNotified, onMessaged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renotifyChoice]);

  const handleClose = () => {
    resetProgress();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Heading level={3} weight="semibold" color="secondary">
            {t('admin.messaging.title')}
          </Heading>
          <button
            onClick={handleClose}
            className="text-gray-600 hover:text-red-500 transition-colors"
            aria-label={t('common.close')}
          >
            <X size={20} />
          </button>
        </div>

        {/* Confirmação de re-envio — só aparece se há candidatos já notificados e ainda não escolheu */}
        {alreadyNotified.length > 0 && renotifyChoice === null && !started && (
          <>
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <Text size="sm" color="inherit" className="text-amber-800">
                {t('admin.messaging.alreadyReceivedMessage', { count: alreadyNotified.length })}
                {notYetNotified.length > 0 && (
                  <> {t('admin.messaging.notYetReceived', { count: notYetNotified.length })}</>
                )}
                {' '}
                {t('admin.messaging.confirmResendQuestion')}
              </Text>
            </div>

            <div className="flex justify-end gap-3">
              <Button variant="outline" size="sm" onClick={handleClose}>
                {t('common.cancel')}
              </Button>
              {notYetNotified.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRenotifyChoice('new-only')}
                  className="border-amber-300 text-amber-700 hover:bg-amber-50"
                >
                  {t('admin.messaging.newOnly', { count: notYetNotified.length })}
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={() => setRenotifyChoice('all')}>
                {t('admin.messaging.resendAll')}
              </Button>
            </div>
          </>
        )}

        {/* Progress list — aparece assim que o envio começa */}
        {started && (
          <div className="flex flex-col gap-2">
            {progress.map(p => (
              <div key={p.workerId} className="flex items-center justify-between">
                <Text size="sm" color="secondary">{p.workerName}</Text>
                <Text
                  as="span"
                  size="sm"
                  color="inherit"
                  className={
                    p.status === 'sent'
                      ? 'text-green-600'
                      : p.status === 'error'
                      ? 'text-red-500'
                      : p.status === 'sending'
                      ? 'text-primary animate-pulse'
                      : 'text-gray-400'
                  }
                >
                  {p.status === 'sent'
                    ? t('admin.messaging.statusSent')
                    : p.status === 'error'
                    ? `${t('admin.messaging.statusErrorPrefix')}${p.error ?? t('admin.messaging.statusErrorFallback')}`
                    : p.status === 'sending'
                    ? t('admin.messaging.statusSending')
                    : t('admin.messaging.statusWaiting')}
                </Text>
              </div>
            ))}

            {isSending && (
              <div className="flex items-center gap-2 text-primary mt-1">
                <Loader2 className="w-4 h-4 animate-spin" />
                <Text as="span" size="sm" color="inherit" className="text-primary">
                  {t('admin.messaging.sending')}
                </Text>
              </div>
            )}

            {done && (
              <div className="mt-2 pt-3 border-t border-gray-200 flex items-center justify-between">
                <Text size="sm" weight="medium" color="secondary">
                  {t('admin.messaging.doneLabel')}{' '}
                  {t('admin.messaging.doneSent', { count: sentCount })},{' '}
                  {t('admin.messaging.doneErrors', { count: errorCount })}
                </Text>
                <Button variant="outline" size="sm" onClick={handleClose}>
                  {t('common.close')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
