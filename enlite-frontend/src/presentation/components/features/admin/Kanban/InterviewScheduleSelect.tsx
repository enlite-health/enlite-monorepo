import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';

export interface InterviewSchedule {
  interviewDate: string;
  interviewTime: string;
  interviewMeetLink?: string;
}

interface InterviewScheduleSelectProps {
  /** Confirma com data/hora, ou sem nada quando a recrutadora ainda não sabe. */
  onSubmit: (schedule: InterviewSchedule | null) => void;
  onCancel: () => void;
}

/**
 * Ao agendar (mover para CONFIRMED), pergunta QUANDO a entrevista é.
 *
 * Até 30/07/2026 o sistema registrava só que a entrevista foi agendada, nunca quando —
 * por isso lembrete de véspera, lembrete de 5min e marcação de falta nunca dispararam.
 *
 * "Ainda não sei" é um caminho de primeira classe (design D4): exigir a data faria a
 * recrutadora inventar um horário para destravar o card, e dado inventado é pior que dado
 * faltando. O painel expõe quantos cards estão sem data, então a lacuna aparece.
 *
 * Espelha o padrão visual do RoleSelect/RejectionReasonSelect.
 */
export function InterviewScheduleSelect({ onSubmit, onCancel }: InterviewScheduleSelectProps) {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [meetLink, setMeetLink] = useState('');

  // Data e hora andam juntas: hora sem data não localiza, data sem hora não permite lembrete.
  const canConfirm = date !== '' && time !== '';

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      data-testid="interview-schedule-modal"
    >
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
        <Heading level={3} className="text-[#180149] mb-1">
          {t('admin.kanban.scheduleModal.title')}
        </Heading>
        <Text as="p" size="sm" color="secondary" className="mb-4">
          {t('admin.kanban.scheduleModal.subtitle')}
        </Text>

        <div className="flex flex-col gap-3 mb-6">
          <label className="flex flex-col gap-1">
            <Text as="span" size="xs" weight="medium" className="text-[#180149]">
              {t('admin.kanban.scheduleModal.dateLabel')}
            </Text>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="interview-date-input"
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <Text as="span" size="xs" weight="medium" className="text-[#180149]">
              {t('admin.kanban.scheduleModal.timeLabel')}
            </Text>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              data-testid="interview-time-input"
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <Text as="span" size="xs" weight="medium" className="text-[#180149]">
              {t('admin.kanban.scheduleModal.meetLabel')}
            </Text>
            <input
              type="url"
              value={meetLink}
              onChange={(e) => setMeetLink(e.target.value)}
              placeholder="https://meet.google.com/..."
              data-testid="interview-meet-input"
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
            />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              className="flex-1"
              data-testid="interview-schedule-cancel"
            >
              {t('admin.kanban.scheduleModal.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                canConfirm &&
                onSubmit({
                  interviewDate: date,
                  interviewTime: time,
                  interviewMeetLink: meetLink.trim() === '' ? undefined : meetLink.trim(),
                })
              }
              disabled={!canConfirm}
              className="flex-1"
              data-testid="interview-schedule-confirm"
            >
              {t('admin.kanban.scheduleModal.confirm')}
            </Button>
          </div>

          {/* Caminho de primeira classe, não escape: agendar sem saber a data é comum. */}
          <button
            type="button"
            onClick={() => onSubmit(null)}
            data-testid="interview-schedule-unknown"
            className="text-xs text-slate-500 underline hover:text-slate-700"
          >
            {t('admin.kanban.scheduleModal.unknown')}
          </button>
        </div>
      </div>
    </div>
  );
}
