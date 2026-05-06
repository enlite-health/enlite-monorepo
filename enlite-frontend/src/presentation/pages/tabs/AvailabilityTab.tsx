import { useMemo, useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { availabilitySchema, AvailabilityFormData } from '@presentation/validation/workerRegistrationSchemas';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { Button } from '@presentation/components/atoms/Button';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { TimeSelect } from '@presentation/components/atoms';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

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
    mode: 'onChange',
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

  const translatedDays = useMemo(() => DAYS_OF_WEEK.map((day, index) => ({
    id: day.id,
    label: t(`workerRegistration.availability.${day.key}`),
    dayIndex: index,
  })), [t]);

  const addTimeSlot = (dayIndex: number): void => {
    // Ativar o dia se não estiver ativo
    if (!schedule[dayIndex]?.enabled) {
      setValue(`schedule.${dayIndex}.enabled`, true, { shouldValidate: true });
    }
    const currentSlots = schedule[dayIndex]?.timeSlots || [];
    setValue(`schedule.${dayIndex}.timeSlots`, [
      ...currentSlots,
      { startTime: '09:00', endTime: '17:00' },
    ], { shouldValidate: true });
    triggerSave();
  };

  const removeTimeSlot = (dayIndex: number, slotIndex: number): void => {
    const currentSlots = schedule[dayIndex]?.timeSlots || [];
    const newSlots = currentSlots.filter((_, i) => i !== slotIndex);
    setValue(`schedule.${dayIndex}.timeSlots`, newSlots, { shouldValidate: true });
    triggerSave();
  };

  const updateTimeSlot = (dayIndex: number, slotIndex: number, field: 'startTime' | 'endTime', value: string): void => {
    const currentSlots = [...(schedule[dayIndex]?.timeSlots || [])];
    currentSlots[slotIndex] = { ...currentSlots[slotIndex], [field]: value };
    setValue(`schedule.${dayIndex}.timeSlots`, currentSlots, { shouldValidate: true });
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

      <div className="flex flex-col gap-4">
        {translatedDays.map((day, dayIndex) => {
          const isEnabled = schedule[dayIndex]?.enabled || false;
          const timeSlots = schedule[dayIndex]?.timeSlots || [];

          return (
            <div
              key={day.id}
              className={`flex flex-col px-4 py-4 rounded-card border-2 transition-all duration-200 ${
                isEnabled ? 'border-primary gap-3' : 'border-gray-600 gap-2'
              }`}
            >
              <div className="flex items-center justify-between">
                <Text
                  as="span"
                  size="base"
                  weight="medium"
                  color={isEnabled ? 'primary' : 'secondary'}
                >
                  {day.label}
                </Text>

                <div className="flex items-center gap-3">
                  <Text as="span" size="sm" color="secondary">
                    {isEnabled && timeSlots.length > 0
                      ? t('workerRegistration.availability.timeSlotsCount', { count: timeSlots.length })
                      : t('workerRegistration.availability.timeSlots')}
                  </Text>

                  <button
                    type="button"
                    onClick={() => addTimeSlot(dayIndex)}
                    className="p-2 rounded-pill bg-primary hover:bg-primary/90 transition-colors"
                  >
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                      <path d="M10 5V15M5 10H15" stroke="white" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>

              {isEnabled && timeSlots.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  {timeSlots.map((slot, slotIndex) => (
                    <div key={slotIndex} className="flex items-center gap-2">
                      {slotIndex > 0 && <Text as="span" size="sm" color="secondary">|</Text>}
                      <div className="flex items-center gap-1 px-2 py-1 bg-primary rounded-input font-lexend text-white text-sm">
                        <TimeSelect
                          value={slot.startTime}
                          onChange={(e) => updateTimeSlot(dayIndex, slotIndex, 'startTime', e.target.value)}
                          className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer [&>option]:text-gray-900"
                        />
                        <Text as="span" size="sm" color="white">-</Text>
                        <TimeSelect
                          value={slot.endTime}
                          onChange={(e) => updateTimeSlot(dayIndex, slotIndex, 'endTime', e.target.value)}
                          className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer [&>option]:text-gray-900"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => removeTimeSlot(dayIndex, slotIndex)}
                        className="p-1 text-primary hover:text-red-500 transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 9.7L2 15.7 0.3 14 6.3 8 0.3 2 2 0.3 8 6.3 14 0.3 15.7 2 9.7 8 15.7 14 14 15.7 8 9.7Z"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

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
