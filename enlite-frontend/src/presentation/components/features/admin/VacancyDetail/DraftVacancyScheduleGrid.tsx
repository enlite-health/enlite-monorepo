import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { buildScheduleGrid, formatScheduleTime, type NormalizedSchedule } from './draftVacancySchedule';

/**
 * A grade de 7 dias do protótipo v3 (F24). Abaixo de `sm` vira LISTA dia a dia (achado #6 do
 * gate fecho 25/09 — a grade de 4 colunas ficava cramped/ilegível a 400px; o protótipo já previa
 * isso: `@media (max-width: 560px) { .sched { grid-template-columns: 1fr } }`). A partir de `sm`
 * vira grade de 7 colunas. Dia sem atendimento mostra travessão na grade e "sin atención" por
 * extenso na lista (mesma distinção do protótipo); dia com mais de um bloco empilha os dois.
 */
export function DraftVacancyScheduleGrid({ schedule }: { schedule: NormalizedSchedule | null }) {
  const { t } = useTranslation();
  const days = buildScheduleGrid(schedule);

  return (
    <ul
      aria-label={t('admin.draftVacancy.schedule.ariaLabel')}
      className="flex flex-col sm:grid sm:grid-cols-7 gap-0 sm:gap-1.5 list-none m-0 p-0"
    >
      {days.map((day) => {
        const isOff = day.blocks.length === 0;
        const short = t(`admin.draftVacancy.days.short.${day.key}`);
        const full = t(`admin.draftVacancy.days.full.${day.key}`);
        return (
          <li
            key={day.key}
            aria-label={isOff ? t('admin.draftVacancy.schedule.dayOffAria', { day: full }) : full}
            className={
              'flex flex-row items-baseline gap-3 py-1.5 border-b border-gray-600 last:border-b-0 ' +
              'sm:flex-col sm:items-center sm:justify-start sm:gap-0.5 sm:border-b-0 sm:py-2 sm:px-1 sm:rounded-lg ' +
              (isOff
                ? 'sm:border sm:border-dashed sm:border-gray-600'
                : 'sm:bg-primary/10')
            }
          >
            <Text as="span" size="2xs" weight="medium" color={isOff ? 'muted' : 'primary'} className="w-9 shrink-0 sm:w-auto">
              {short}
            </Text>
            {isOff ? (
              <>
                <Text as="span" size="xs" color="muted" className="hidden sm:inline" aria-hidden="true">
                  —
                </Text>
                <Text as="span" size="xs" color="muted" className="sm:hidden">
                  {t('admin.draftVacancy.schedule.noAttendance')}
                </Text>
              </>
            ) : (
              <div className="flex flex-col gap-0.5">
                {day.blocks.map((block, i) => (
                  <Text as="span" key={i} size="xs" weight="medium" color="secondary" className="whitespace-nowrap">
                    {t('admin.draftVacancy.schedule.timeRange', {
                      start: formatScheduleTime(block.start),
                      end: formatScheduleTime(block.end),
                    })}
                  </Text>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
