import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useHasCell } from '@presentation/hooks/useCellAccess';
import { useWorkerLostDevice } from '@hooks/admin/useWorkerLostDevice';
import { LostDeviceStatus } from './LostDeviceStatus';
import { LostDeviceConfirmDialog } from './LostDeviceConfirmDialog';

interface WorkerLostDeviceCardProps {
  workerId: string;
}

/**
 * "Celular perdido" na ficha da cuidadora (spec 077, D795, T-F3c-DB-13/14).
 *
 * · Visível SÓ com a célula `worker_device:revoke` — `useHasCell`, não `useActionGate`: com o engine desligado o
 *   `useActionGate` libera, e aqui a regra é "sem a célula, não existe" (quem recebe a célula: C-levels, G-11).
 * · NÃO desativa a conta (G-9): desativar é outra ação, que já existe.
 * · O estado vem do servidor e é relido depois do clique; `pushSent` aparece só como retorno do clique.
 * · Sem retry automático: se o pedido falhar, a tela mostra o erro e o status que o servidor tiver.
 * · Escondido também quando não há aparelho ativo nem revogação a mostrar.
 */
export function WorkerLostDeviceCard({ workerId }: WorkerLostDeviceCardProps): JSX.Element | null {
  const { t } = useTranslation();
  const tl = (k: string) => t(`admin.workerDetail.lostDevice.${k}`);
  const canRevoke = useHasCell('worker_device', 'revoke');
  const { status, loadFailed, busy, feedback, revoke } = useWorkerLostDevice(workerId, canRevoke);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!canRevoke) return null;
  if (!loadFailed && status === null) return null;
  if (status && !status.hasActiveDevice && !status.lastOperatorRevocation && !feedback) return null;

  const handleConfirm = async () => {
    await revoke();
    setConfirmOpen(false);
  };
  const isError = feedback === 'errorNoDevice' || feedback === 'errorRevoke';

  return (
    <div className="mb-6 bg-white rounded-card border-2 border-gray-600 px-4 py-3 sm:px-6 sm:py-4 flex flex-col gap-3" data-testid="worker-lost-device-card">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <span className="flex flex-col">
          <Text as="span" size="sm" weight="medium" color="secondary">{tl('title')}</Text>
          <Text as="span" size="xs" color="muted">{tl('hint')}</Text>
        </span>
        {status?.hasActiveDevice && (
          <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)} disabled={busy} data-testid="worker-lost-device-button">
            {tl('button')}
          </Button>
        )}
      </div>
      {loadFailed && <Text size="xs" color="inherit" className="text-red-600" data-testid="lost-device-load-error">{tl('errorLoad')}</Text>}
      {status?.lastOperatorRevocation && <LostDeviceStatus revocation={status.lastOperatorRevocation} />}
      {feedback && (
        <Text size="xs" color={isError ? 'inherit' : 'secondary'} className={isError ? 'text-red-600' : undefined} data-testid="lost-device-feedback">
          {tl(feedback)}
        </Text>
      )}
      {confirmOpen && (
        <LostDeviceConfirmDialog busy={busy} onConfirm={() => void handleConfirm()} onClose={() => setConfirmOpen(false)} />
      )}
    </div>
  );
}
