import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { formatDDMM } from './substitutionDates';

interface ScheduledAttendanceWarningProps {
  /** Datas (`YYYY-MM-DD`) em que o prestador é o substituto — do 409 `WORKER_HAS_SCHEDULED_ATTENDANCES`. */
  substitutionDates: string[];
  /** 1ª data de uma entrada futura dele como titular; `null` = não tem. */
  futureEntryFrom: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  submitting?: boolean;
}

/** Aviso antes de tirar quem tem atendimento agendado (058 P5c): lista as datas; confirmar cancela e registra, voltar não envia nada. */
export function ScheduledAttendanceWarning({ substitutionDates, futureEntryFrom, onConfirm, onCancel, submitting = false }: ScheduledAttendanceWarningProps): JSX.Element {
  const { t } = useTranslation();
  const tw = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.removePanel.scheduledWarning.${key}`, opts);
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-amber-400 bg-amber-50 p-3" data-testid="aviso-agendados">
      <Text size="sm" weight="semibold" color="primary">{tw('title')}</Text>
      {substitutionDates.length > 0 && (
        <Text size="sm" color="secondary" data-testid="aviso-agendados-datas">{tw('substitutions', { dates: substitutionDates.map(formatDDMM).join(', ') })}</Text>
      )}
      {futureEntryFrom && (
        <Text size="sm" color="secondary" data-testid="aviso-agendados-entrada">{tw('entry', { date: formatDDMM(futureEntryFrom) })}</Text>
      )}
      <div className="flex gap-3">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting} data-testid="aviso-agendados-cancelar">{tw('back')}</Button>
        <Button variant="primary" size="sm" onClick={onConfirm} disabled={submitting} data-testid="aviso-agendados-confirmar">{tw('confirm')}</Button>
      </div>
    </div>
  );
}
