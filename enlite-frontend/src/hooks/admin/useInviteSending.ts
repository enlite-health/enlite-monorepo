import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { blockedReasonMessage } from '@infrastructure/http/AdminMessagingApiService';
import { useInviteProgressStore, type SendItem } from '@presentation/stores/inviteProgressStore';
import type { InviteTarget } from '@presentation/components/features/admin/VacancyMatch/inviteTypes';

export type RowSend = { kind: 'sending' } | { kind: 'error'; text: string };
export interface StepOutcome { sent: number; failed: number }

/**
 * Ponte entre a página e a fila de envio global (DF-18, DF-19). A fila é do navegador e sobrevive à
 * navegação; aqui só se lê. Quando `isSending` vira `false` (também se a página remontou no meio do
 * envio): congela o resultado por passo desta visita, e relê o servidor com UM GET (`refetch`) —
 * nunca POST. Até o GET voltar, quem já saiu aparece "Invitado hoy" pelo `messagedAt` do callback.
 */
export function useInviteSending(vacancyId: string | undefined, step: string, refetch: () => Promise<void>) {
  const { t } = useTranslation();
  const items = useInviteProgressStore((s) => s.items);
  const isSending = useInviteProgressStore((s) => s.isSending);
  const stepOf = useRef<Record<string, string>>({});
  const startIdx = useRef(0);
  const stepRef = useRef(step);
  stepRef.current = step;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const wasSending = useRef(isSending);
  const [sentByStep, setSentByStep] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, { step: string; text: string }>>({});
  const [localMessaged, setLocalMessaged] = useState<Record<string, string>>({});

  const errorText = (i: SendItem): string =>
    i.errorCode ? blockedReasonMessage(i.errorCode, i.errorDetail, t) : (i.error ?? t('admin.messaging.statusErrorFallback'));

  useEffect(() => {
    if (wasSending.current && !isSending) {
      const mine = useInviteProgressStore.getState().items.slice(startIdx.current).filter((i) => i.vacancyId === vacancyId);
      const stepFor = (id: string) => stepOf.current[id] ?? stepRef.current;
      const ok = mine.filter((i) => i.status === 'sent');
      const bad = mine.filter((i) => i.status === 'error');
      setSentByStep((cur) => {
        const next = { ...cur };
        for (const i of ok) next[stepFor(i.workerId)] = (next[stepFor(i.workerId)] ?? 0) + 1;
        return next;
      });
      setFailed((cur) => {
        const next = { ...cur };
        for (const i of ok) delete next[i.workerId];
        for (const i of bad) next[i.workerId] = { step: stepFor(i.workerId), text: errorText(i) };
        return next;
      });
      void refetchRef.current().then(() => setLocalMessaged({}));
    }
    wasSending.current = isSending;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSending, vacancyId]);

  const live = new Map<string, SendItem>();
  for (const i of items) if (i.vacancyId === vacancyId) live.set(i.workerId, i);

  const rowSend = (workerId: string): RowSend | undefined => {
    const it = live.get(workerId);
    if (it && (it.status === 'pending' || it.status === 'sending')) return { kind: 'sending' };
    const f = failed[workerId];
    return f ? { kind: 'error', text: f.text } : undefined;
  };

  const enqueue = (targets: InviteTarget[]): void => {
    if (!vacancyId || targets.length === 0) return;
    const store = useInviteProgressStore.getState();
    if (!store.isSending) startIdx.current = store.items.length;
    for (const tg of targets) stepOf.current[tg.workerId] = stepRef.current;
    store.enqueue(vacancyId, targets, (workerId, at) => setLocalMessaged((c) => ({ ...c, [workerId]: at })));
  };

  const outcomeOf = (stepKey: string): StepOutcome => ({
    sent: sentByStep[stepKey] ?? 0,
    failed: Object.values(failed).filter((f) => f.step === stepKey).length,
  });

  return { isSending, sentByStep, localMessaged, rowSend, enqueue, outcomeOf };
}
