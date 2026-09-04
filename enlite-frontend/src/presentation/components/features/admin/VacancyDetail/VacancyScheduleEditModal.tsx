import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from '@presentation/components/features/access';
import {
  DayScheduleEditor,
  type DayScheduleSlot,
} from '@presentation/components/molecules/DayScheduleEditor';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

interface VacancyScheduleEditModalProps {
  isOpen: boolean;
  vacancyId: string;
  vacancy: unknown;
  onClose: () => void;
  onSuccess: () => void;
}

const DAY_NAME_TO_INDEX: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, 'miércoles': 3,
  jueves: 4, viernes: 5, sabado: 6, 'sábado': 6,
};

/**
 * Hidrata os slots no formato JSONB canônico a partir do shape que a vacancy
 * pode trazer (Array do JSONB OU Record<diaName, slots> normalizado pelo
 * backend no GET).
 */
function hydrateSlots(vacancy: unknown): DayScheduleSlot[] {
  if (!vacancy || typeof vacancy !== 'object') return [];
  const raw = (vacancy as { schedule?: unknown }).schedule;
  if (!raw) return [];

  // Já está no formato Array<{dayOfWeek, startTime, endTime}>
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is DayScheduleSlot =>
        s != null && typeof s === 'object'
        && typeof (s as DayScheduleSlot).dayOfWeek === 'number'
        && typeof (s as DayScheduleSlot).startTime === 'string'
        && typeof (s as DayScheduleSlot).endTime === 'string',
      );
  }

  // Record<diaName, Array<{start, end}>> (saída do scheduleNormalizer do backend)
  if (typeof raw === 'object') {
    const out: DayScheduleSlot[] = [];
    for (const [dayName, slots] of Object.entries(raw as Record<string, unknown>)) {
      const dayIndex = DAY_NAME_TO_INDEX[dayName.toLowerCase()];
      if (dayIndex == null || !Array.isArray(slots)) continue;
      for (const slot of slots) {
        if (slot && typeof slot === 'object' && 'start' in slot && 'end' in slot) {
          out.push({
            dayOfWeek: dayIndex,
            startTime: String((slot as { start: unknown }).start),
            endTime: String((slot as { end: unknown }).end),
          });
        }
      }
    }
    return out;
  }
  return [];
}

export function VacancyScheduleEditModal({
  isOpen,
  vacancyId,
  vacancy,
  onClose,
  onSuccess,
}: VacancyScheduleEditModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [slots, setSlots] = useState<DayScheduleSlot[]>(() => hydrateSlots(vacancy));
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSlots(hydrateSlots(vacancy));
      setApiError(null);
    }
  }, [isOpen, vacancy]);

  if (!isOpen) return null;

  const hasValidSlot = slots.length > 0
    && slots.every((s) => s.startTime && s.endTime);

  const handleSubmit = async (): Promise<void> => {
    setApiError(null);
    if (!hasValidSlot) {
      setApiError(t('admin.vacancyDetail.scheduleEditor.errorEmpty'));
      return;
    }
    setSaving(true);
    try {
      await AdminApiService.updateVacancy(vacancyId, { schedule: slots });
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApiError(message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-slate-900/60 z-[60]"
        onClick={() => !saving && onClose()}
        data-testid="vacancy-schedule-modal-backdrop"
      />

      <aside
        className="fixed top-[10px] bottom-[10px] right-0 z-[60] w-full max-w-md bg-white shadow-2xl rounded-tl-2xl rounded-bl-2xl flex flex-col"
        data-testid="vacancy-schedule-modal"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 shrink-0">
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

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <Text size="sm" color="secondary">
            {t('admin.vacancyDetail.scheduleEditor.subtitle')}
          </Text>

          <DayScheduleEditor value={slots} onChange={setSlots} disabled={saving} />

          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              <Text size="sm" color="inherit" className="text-red-600">
                {apiError}
              </Text>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-100 shrink-0">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t('admin.vacancyDetail.scheduleEditor.cancel')}
          </Button>
          {/* PUT /vacancies/:id → updateVacancy → vacancy:write. */}
          <ActionButton
            resource="vacancy"
            action="write"
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
          </ActionButton>
        </div>
      </aside>
    </>,
    document.body,
  );
}
