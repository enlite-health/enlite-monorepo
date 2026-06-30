import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { availabilitySchema, AvailabilityFormData } from '@presentation/validation/workerRegistrationSchemas';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useToast } from '@presentation/hooks/useToast';
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
  const showToast = useToast();

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
      showToast(t('profile.saveSuccess', 'Información guardada con éxito'), 'success', 'profile-save');
    },
    500,
    (error) => {
      showToast(
        error instanceof Error ? error.message : t('workerRegistration.availability.saveError'),
        'error',
        'profile-save',
      );
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

  return (
    <div className="flex flex-col gap-6 w-full" onBlur={triggerSave}>
      <Heading level={3} weight="medium" color="secondary">
        {t('workerRegistration.availability.title')}
      </Heading>

      <DayScheduleEditor value={flatSlots} onChange={handleScheduleChange} />

      {errors.schedule && (
        <Text as="span" size="sm" color="inherit" className="text-red-500">
          {errors.schedule.message}
        </Text>
      )}
    </div>
  );
}
