import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { availabilitySchema, AvailabilityFormData } from '@presentation/validation/workerRegistrationSchemas';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { Button } from '@presentation/components/atoms/Button';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  DayScheduleEditor,
  type DayScheduleSlot,
} from '@presentation/components/molecules/DayScheduleEditor';

const DAYS_OF_WEEK = [
  { id: 'sunday', key: 'sunday' },
  { id: 'monday', key: 'monday' },
  { id: 'tuesday', key: 'tuesday' },
  { id: 'wednesday', key: 'wednesday' },
  { id: 'thursday', key: 'thursday' },
  { id: 'friday', key: 'friday' },
  { id: 'saturday', key: 'saturday' },
];


export function AvailabilityTab(): JSX.Element {
  const { t } = useTranslation();
  const { saveAvailability, getAvailability } = useWorkerApi();

  // Use individual selectors to prevent re-renders
  const data = useWorkerRegistrationStore((state) => state.data);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    watch,
    formState: { errors },
    setValue,
    reset,
    getValues,
  } = useForm<AvailabilityFormData>({
    resolver: zodResolver(availabilitySchema),
    defaultValues: {
      schedule: data.availability.schedule || DAYS_OF_WEEK.map((day) => ({
        day: day.id,
        enabled: false,
        timeSlots: [],
      })),
    },
    mode: 'onTouched',
  });

  // Buscar dados reais do backend e preencher formulário
  useEffect(() => {
    const fetchAvailability = async () => {
      try {
        const slots = await getAvailability();

        if (slots && slots.length > 0) {
          const schedule = DAYS_OF_WEEK.map((day, dayIndex) => {
            const daySlots = slots.filter((s) => s.dayOfWeek === dayIndex);

            return {
              day: day.id,
              enabled: daySlots.length > 0,
              timeSlots: daySlots.map((s) => ({
                startTime: s.startTime.slice(0, 5),
                endTime: s.endTime.slice(0, 5),
              })),
            };
          });

          reset({ schedule });
        }
      } catch (error) {
        console.error('Failed to fetch worker availability:', error);
      }
    };

    fetchAvailability();
  }, [getAvailability, reset]);

  const triggerSave = useAutoSave(
    async () => {
      const formData = getValues();
      const availability = (formData.schedule || []).flatMap((daySchedule, dayIndex) => {
        if (!daySchedule.enabled) return [];
        return (daySchedule.timeSlots || []).map((slot) => ({
          dayOfWeek: dayIndex,
          startTime: slot.startTime,
          endTime: slot.endTime,
        }));
      });
      await saveAvailability({ availability });
    },
    500,
    (error) => {
      setSaveError(error instanceof Error ? error.message : t('workerRegistration.availability.saveError'));
    },
  );

  const schedule = watch('schedule');

  // Mapeia o form state (Array<{day, enabled, timeSlots[]}>) pro formato JSONB
  // canônico que o DayScheduleEditor consome (Array<DayScheduleSlot>).
  const flatSlots: DayScheduleSlot[] = (schedule || []).flatMap((daySchedule, dayIndex) => {
    if (!daySchedule?.enabled) return [];
    return (daySchedule.timeSlots || []).map((slot) => ({
      dayOfWeek: dayIndex,
      startTime: slot.startTime,
      endTime: slot.endTime,
    }));
  });

  const handleScheduleChange = (next: DayScheduleSlot[]): void => {
    const newSchedule = DAYS_OF_WEEK.map((day, dayIndex) => {
      const daySlots = next.filter((s) => s.dayOfWeek === dayIndex);
      return {
        day: day.id,
        enabled: daySlots.length > 0,
        timeSlots: daySlots.map((s) => ({ startTime: s.startTime, endTime: s.endTime })),
      };
    });
    setValue('schedule', newSchedule, { shouldValidate: true });
    triggerSave();
  };

  const onSubmit = async (): Promise<void> => {
    setSaveError(null);
    setSaveSuccess(false);
    setIsSaving(true);
    try {
      const availability = schedule.flatMap((daySchedule, dayIndex) => {
        if (!daySchedule.enabled) return [];
        return (daySchedule.timeSlots || []).map((slot) => ({
          dayOfWeek: dayIndex,
          startTime: slot.startTime,
          endTime: slot.endTime,
        }));
      });
      await saveAvailability({ availability });
      setSaveSuccess(true);
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('workerRegistration.availability.saveError'));
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-6 w-full" onBlur={triggerSave}>
      {/* Success/Error Messages */}
      {saveSuccess && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-input">
          <Text as="span" size="sm" color="inherit" className="text-green-700">
            {t('profile.saveSuccess', 'Informações salvas com sucesso!')}
          </Text>
        </div>
      )}
      {saveError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-input">
          <Text as="span" size="sm" color="inherit" className="text-red-700">
            {saveError}
          </Text>
        </div>
      )}

      <Heading level={3} weight="medium" color="secondary">
        {t('workerRegistration.availability.title')}
      </Heading>

      <DayScheduleEditor value={flatSlots} onChange={handleScheduleChange} />

      {errors.schedule && (
        <Text as="span" size="sm" color="inherit" className="text-red-500">
          {errors.schedule.message}
        </Text>
      )}

      {/* Submit Button */}
      <div className="flex justify-end pt-4">
        <Button
          type="button"
          onClick={onSubmit}
          variant="primary"
          size="md"
          isLoading={isSaving}
        >
          {t('profile.save', 'Salvar')}
        </Button>
      </div>
    </div>
  );
}
