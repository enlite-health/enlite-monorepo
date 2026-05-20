import { useState, useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { MessageTemplate, SavedCandidate } from '../../types/match';

const SEND_INTERVAL_MS = 300; // Intervalo entre envios para evitar rate limit do Twilio

export interface SendProgress {
  workerId: string;
  workerName: string;
  status: 'pending' | 'sending' | 'sent' | 'error';
  error?: string;
}

export function useMatchMessaging(vacancyId: string | undefined) {
  const [templates, setTemplates]         = useState<MessageTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [isSending, setIsSending]         = useState(false);
  const [progress, setProgress]           = useState<SendProgress[]>([]);

  const fetchTemplates = useCallback(async () => {
    try {
      setIsLoadingTemplates(true);
      const data = await AdminApiService.getMessageTemplates();
      setTemplates(data);
    } catch (err: any) {
      console.error('[useMatchMessaging] Falha ao carregar templates:', err.message);
    } finally {
      setIsLoadingTemplates(false);
    }
  }, []);

  /**
   * Renderiza o preview do template server-side — texto exato que o
   * destinatário receberá. Retorna null em erro (UI exibe fallback).
   */
  const fetchPreview = useCallback(async (
    workerId: string,
    templateSlug: string,
  ): Promise<string | null> => {
    if (!vacancyId) return null;
    try {
      const data = await AdminApiService.previewWhatsApp(workerId, templateSlug, vacancyId);
      return data.renderedBody;
    } catch (err: any) {
      console.error('[useMatchMessaging] Falha ao carregar preview:', err.message);
      return null;
    }
  }, [vacancyId]);

  /**
   * Envia WhatsApp para um único worker.
   * Retorna o timestamp ISO de envio ou lança erro.
   */
  const sendToOne = useCallback(async (
    candidate: SavedCandidate,
    templateSlug: string,
    variables: Record<string, string>
  ): Promise<string> => {
    await AdminApiService.sendWhatsApp(
      candidate.workerId,
      templateSlug,
      variables,
      vacancyId
    );
    return new Date().toISOString();
  }, [vacancyId]);

  /**
   * Envia WhatsApp em lote para os candidatos selecionados.
   * Loop sequencial com intervalo de 300ms para respeitar rate limit do Twilio.
   * `onMessaged` é chamado após cada envio bem-sucedido para atualizar o state pai.
   */
  const sendBatch = useCallback(async (
    candidates: SavedCandidate[],
    templateSlug: string,
    buildVariables: (candidate: SavedCandidate) => Record<string, string>,
    onMessaged: (workerId: string, messagedAt: string) => void
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
        p.workerId === candidate.workerId ? { ...p, status: 'sending' } : p
      ));

      try {
        const messagedAt = await sendToOne(candidate, templateSlug, buildVariables(candidate));
        onMessaged(candidate.workerId, messagedAt);
        setProgress(prev => prev.map(p =>
          p.workerId === candidate.workerId ? { ...p, status: 'sent' } : p
        ));
      } catch (err: any) {
        setProgress(prev => prev.map(p =>
          p.workerId === candidate.workerId
            ? { ...p, status: 'error', error: err.message || 'Falha no envio' }
            : p
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
    templates,
    isLoadingTemplates,
    isSending,
    progress,
    fetchTemplates,
    fetchPreview,
    sendToOne,
    sendBatch,
    resetProgress,
  };
}
