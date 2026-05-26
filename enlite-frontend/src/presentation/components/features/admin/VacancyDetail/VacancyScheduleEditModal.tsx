import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { SchedulePicker } from '../VacancySchedulePicker';
import { buildScheduleFromVacancy, scheduleToJsonb } from '../vacancy-form-schema';
import type { ScheduleValue } from '../vacancyScheduleUtils';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

interface VacancyScheduleEditModalProps {
  isOpen: boolean;
  vacancyId: string;
  vacancy: unknown;
  onClose: () => void;
  onSuccess: () => void;
}

export function VacancyScheduleEditModal({
  isOpen,
  vacancyId,
  vacancy,
  onClose,
  onSuccess,
}: VacancyScheduleEditModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [schedule, setSchedule] = useState<ScheduleValue>(() => buildScheduleFromVacancy(vacancy));
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSchedule(buildScheduleFromVacancy(vacancy));
      setApiError(null);
    }
  }, [isOpen, vacancy]);

  if (!isOpen) return null;

  const hasValidSlot = schedule.some(
    (entry) => entry.days.length > 0 && entry.timeFrom && entry.timeTo,
  );

  const handleSubmit = async (): Promise<void> => {
    setApiError(null);
    if (!hasValidSlot) {
      setApiError(t('admin.vacancyDetail.scheduleEditor.errorEmpty'));
      return;
    }
    setSaving(true);
    try {
      const slots = scheduleToJsonb(schedule);
      await AdminApiService.updateVacancy(vacancyId, { schedule: slots });
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApiError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && !saving && onClose()}
      data-testid="vacancy-schedule-modal"
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <Heading level={3} weight="semibold" color="secondary">
            {t('admin.vacancyDetail.scheduleEditor.title')}
          </Heading>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-[#737373] hover:text-red-500 transition-colors p-1 rounded disabled:opacity-50"
            aria-label={t('admin.vacancyDetail.scheduleEditor.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <Text size="sm" color="secondary">
            {t('admin.vacancyDetail.scheduleEditor.subtitle')}
          </Text>

          <SchedulePicker value={schedule} onChange={setSchedule} />

          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              <Text size="sm" color="inherit" className="text-red-600">
                {apiError}
              </Text>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
              {t('admin.vacancyDetail.scheduleEditor.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              isLoading={saving}
              disabled={saving}
              data-testid="vacancy-schedule-save"
            >
              {saving
                ? t('admin.vacancyDetail.scheduleEditor.saving')
                : t('admin.vacancyDetail.scheduleEditor.save')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
