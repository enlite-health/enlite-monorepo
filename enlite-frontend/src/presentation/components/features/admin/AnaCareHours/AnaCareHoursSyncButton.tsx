/**
 * Botão "Sincronizar" da lista (F6.4/tasks 4.8-4.9) — puramente controlado pelo estado que
 * `useAnaCareHoursSync` devolve. Sem lógica de laço/rede aqui (isso é do hook) — só apresentação.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import type { AnaCareHoursSyncStatus } from '@hooks/admin/useAnaCareHoursSync';

interface AnaCareHoursSyncButtonProps {
  status: AnaCareHoursSyncStatus;
  round: number;
  reservationsProcessed: number;
  error: string | null;
  resumableCursor: number | null;
  onStart: () => void;
}

export function AnaCareHoursSyncButton({
  status,
  round,
  reservationsProcessed,
  error,
  resumableCursor,
  onStart,
}: AnaCareHoursSyncButtonProps): JSX.Element {
  const { t } = useTranslation();
  const isRunning = status === 'running';
  const label = resumableCursor !== null && !isRunning ? t('admin.anacareHours.sync.resumeButton') : t('admin.anacareHours.sync.button');

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={onStart} isLoading={isRunning} data-testid="anacare-hours-sync-button">
        {label}
      </Button>
      {isRunning && (
        <Text as="span" size="xs" color="muted" data-testid="anacare-hours-sync-progress">
          {t('admin.anacareHours.sync.progress', { round, count: reservationsProcessed })}
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
    </div>
  );
}
