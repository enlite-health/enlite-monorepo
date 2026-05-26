import { useState, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { InviteTarget } from '@presentation/components/features/admin/VacancyMatch/inviteTypes';

const SEND_INTERVAL_MS = 300; // Intervalo entre envios para evitar rate limit do Twilio

export interface SendProgress {
  workerId: string;
  workerName: string;
  status: 'pending' | 'sending' | 'sent' | 'error';
  error?: string;
}

export function useMatchMessaging(vacancyId: string | undefined) {
  const [isSending, setIsSending] = useState(false);
  const [progress, setProgress]   = useState<SendProgress[]>([]);

  /**
   * Envia convite de match WhatsApp para um único worker.
   * O backend decide o slug do template automaticamente (complete vs incomplete).
   * Retorna o timestamp ISO de envio ou lança erro.
   */
  const sendToOne = useCallback(async (candidate: InviteTarget): Promise<string> => {
    if (!vacancyId) throw new Error('vacancyId obrigatório');
    await AdminApiService.sendVacancyMatchInvite(candidate.workerId, vacancyId);
    return new Date().toISOString();
  }, [vacancyId]);

  /**
   * Envia convite em lote para os candidatos selecionados.
   * Loop sequencial com intervalo de 300ms para respeitar rate limit do Twilio.
   * `onMessaged` é chamado após cada envio bem-sucedido para atualizar o state pai.
   */
  const sendBatch = useCallback(async (
    candidates: InviteTarget[],
    onMessaged: (workerId: string, messagedAt: string) => void,
  ) => {
    setIsSending(true);
    setProgress(candidates.map(c => ({
      workerId:   c.workerId,
      workerName: c.workerName,
      status:     'pending',
    })));

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      setProgress(prev => prev.map(p =>
        p.workerId === candidate.workerId ? { ...p, status: 'sending' } : p,
      ));

      try {
        const messagedAt = await sendToOne(candidate);
        onMessaged(candidate.workerId, messagedAt);
        setProgress(prev => prev.map(p =>
          p.workerId === candidate.workerId ? { ...p, status: 'sent' } : p,
        ));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Falha no envio';
        setProgress(prev => prev.map(p =>
          p.workerId === candidate.workerId
            ? { ...p, status: 'error', error: message }
            : p,
        ));
      }

      // Aguarda intervalo entre envios (exceto no último)
      if (i < candidates.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SEND_INTERVAL_MS));
      }
    }

    setIsSending(false);
  }, [sendToOne]);

  const resetProgress = useCallback(() => setProgress([]), []);

  return {
    isSending,
    progress,
    sendToOne,
    sendBatch,
    resetProgress,
  };
}
