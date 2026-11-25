import { useCallback, useEffect, useState } from 'react';
import { AdminWorkerDeviceApiService } from '@infrastructure/http/AdminWorkerDeviceApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import type { WorkerDeviceStatus } from '@domain/entities/WorkerDevice';

/** Retorno do clique (chave i18n em `admin.workerDetail.lostDevice`). Não é guardado: some ao reabrir a ficha. */
export type LostDeviceFeedback = 'pushSent' | 'pushNotSent' | 'errorNoDevice' | 'errorRevoke';

/**
 * "Celular perdido" (spec 077, D795): lê o status do servidor e faz o pedido. `enabled=false` (sem a célula) = nada é lido.
 * Sem retry automático: se o pedido falhar, devolve o erro e relê o status — a leitura é do servidor, não um novo pedido.
 */
export function useWorkerLostDevice(workerId: string, enabled: boolean) {
  const [status, setStatus] = useState<WorkerDeviceStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<LostDeviceFeedback | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await AdminWorkerDeviceApiService.getStatus(workerId));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [workerId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const revoke = useCallback(async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await AdminWorkerDeviceApiService.revoke(workerId);
      setFeedback(result.pushSent ? 'pushSent' : 'pushNotSent');
    } catch (error) {
      setFeedback(error instanceof ApiError && error.status === 404 ? 'errorNoDevice' : 'errorRevoke');
    } finally {
      setBusy(false);
      await load();
    }
  }, [workerId, load]);

  return { status, loadFailed, busy, feedback, revoke };
}
