import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';

// Schedule keys arrive in Spanish (ClickUp source); map each to its canonical
// weekday i18n key. Labels (with trailing colon) are reused from the SSOT used
// by the admin schedule rows — see admin.vacancyDetail.professionCard.weekdays.
const DAY_ORDER: { key: string; i18nKey: string }[] = [
  { key: 'domingo', i18nKey: 'sunday' },
  { key: 'lunes', i18nKey: 'monday' },
  { key: 'martes', i18nKey: 'tuesday' },
  { key: 'miercoles', i18nKey: 'wednesday' },
  { key: 'jueves', i18nKey: 'thursday' },
  { key: 'viernes', i18nKey: 'friday' },
  { key: 'sabado', i18nKey: 'saturday' },
];

interface ScheduleSectionProps {
  schedule: Record<string, { start: string; end: string }[]>;
}

export function ScheduleSection({ schedule }: ScheduleSectionProps) {
  const { t } = useTranslation();

  // Only render days that actually have coverage — avoids empty "hole" rows.
  const activeDays = DAY_ORDER.filter((day) => (schedule[day.key] ?? []).length > 0);

  if (activeDays.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {/* Título com ícone */}
      <div className="flex items-center gap-1.5">
        <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
        <Text as="span" size="sm" weight="medium">
          {t('publicVacancy.daysAndHours')}
        </Text>
      </div>
      {/* Grid de dias e horários */}
      <div className="ml-6 flex gap-4">
        {/* Coluna de dias */}
        <div className="flex flex-col gap-3 w-[103px] shrink-0">
          {activeDays.map((day) => (
            <Text key={day.key} size="sm" weight="medium">
              {t(`admin.vacancyDetail.professionCard.weekdays.${day.i18nKey}`)}
            </Text>
          ))}
        </div>
        {/* Coluna de horários */}
        <div className="flex flex-col gap-2">
          {activeDays.map((day) => (
            <div key={day.key} className="flex gap-2 flex-wrap min-h-[24px] items-center">
              {(schedule[day.key] ?? []).map((slot, i) => (
                <span
                  key={i}
                  className="bg-primary text-[#edf2fe] text-xs font-lexend font-medium px-3 py-1 rounded tracking-[0.04px] leading-4"
                >
                  {slot.start} - {slot.end}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
