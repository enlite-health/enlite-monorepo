/**
 * Botão "Sincronizar" da lista (F6.4/tasks 4.8-4.9) — puramente controlado pelo estado que
 * `useAnaCareHoursSync` devolve. Sem lógica de laço/rede aqui (isso é do hook) — só apresentação.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import type { AnaCareHoursSyncStatus } from '@hooks/admin/useAnaCareHoursSync';
import { formatMonthLabel } from './selectors';

interface AnaCareHoursSyncButtonProps {
  status: AnaCareHoursSyncStatus;
  round: number;
  reservationsProcessed: number;
  /**
   * change `anacare-horas-feedback-visual-sync` (Requisito 1) — TOTAL/ACUMULADO da corrida, do
   * hook (`useAnaCareHoursSync`). `null` antes da 1ª rodada responder, ou se a resposta não
   * trouxer os campos (nunca "undefined de undefined" — cai no texto antigo de round/processadas).
   */
  reservationsTotal: number | null;
  reservationsDone: number | null;
  error: string | null;
  resumableCursor: number | null;
  /** Mês de uma corrida cancelada por troca de mês com rodada em voo (ver `useAnaCareHoursSync`) — linha própria, nunca silêncio. */
  interruptedMonth?: string | null;
  onStart: () => void;
}

export function AnaCareHoursSyncButton({
  status,
  round,
  reservationsProcessed,
  reservationsTotal,
  reservationsDone,
  error,
  resumableCursor,
  interruptedMonth = null,
  onStart,
}: AnaCareHoursSyncButtonProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const isRunning = status === 'running';
  const idleLabel = resumableCursor !== null ? t('admin.anacareHours.sync.resumeButton') : t('admin.anacareHours.sync.button');
  // Requisito 2: o botão NUNCA vira só "Cargando…" (`Button.tsx` trocaria o `children` inteiro por
  // `common.loading` com `isLoading=true`) — por isso `isLoading` é SEMPRE `false` aqui, e o
  // rótulo/estado de "rodando" é PRÓPRIO deste componente, controlado por `disabled={isRunning}`.
  // `Button.tsx` global e as dezenas de outras telas que o chamam continuam intocados (diff zero).
  const label = isRunning ? t('admin.anacareHours.sync.runningLabel') : idleLabel;
  const hasCount = reservationsTotal !== null && reservationsDone !== null;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={onStart} isLoading={false} disabled={isRunning} data-testid="anacare-hours-sync-button">
        {label}
      </Button>
      {isRunning && (
        <Text as="span" size="xs" color="muted" data-testid="anacare-hours-sync-progress">
          {hasCount
            ? t('admin.anacareHours.sync.progressCount', { done: reservationsDone, total: reservationsTotal })
            : t('admin.anacareHours.sync.progress', { round, count: reservationsProcessed })}
        </Text>
      )}
      {status === 'error' && error && (
        <Text as="span" size="xs" className="!text-red-600" data-testid="anacare-hours-sync-error">
          {error}
        </Text>
      )}
      {status === 'idle' && resumableCursor !== null && (
        <Text as="span" size="xs" color="muted" data-testid="anacare-hours-sync-resume-hint">
          {t('admin.anacareHours.sync.resumeHint')}
        </Text>
      )}
      {status === 'done' && (
        <Text as="span" size="xs" color="muted" data-testid="anacare-hours-sync-done">
          {t('admin.anacareHours.sync.done')}
        </Text>
      )}
      {status === 'deduped' && (
        <Text as="span" size="xs" color="muted" data-testid="anacare-hours-sync-deduped">
          {t('admin.anacareHours.sync.deduped')}
        </Text>
      )}
      {interruptedMonth && (
        <Text as="span" size="xs" color="muted" data-testid="anacare-hours-sync-interrupted">
          {t('admin.anacareHours.sync.interrupted', { month: formatMonthLabel(interruptedMonth, i18n.language) })}
        </Text>
      )}
    </div>
  );
}
