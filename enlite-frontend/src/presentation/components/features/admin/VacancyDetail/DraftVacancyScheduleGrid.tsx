import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { buildScheduleGrid, formatScheduleTime, type NormalizedSchedule } from './draftVacancySchedule';

/**
 * A grade de 7 dias do protótipo v3 (F24) — uma coluna por dia no desktop, lista no celular
 * (responsividade via `sm:` do Tailwind, mesmo espírito do `.sched` do protótipo). Dia sem
 * atendimento mostra travessão em vez do tempo (F28); dia com mais de um bloco empilha os dois.
 */
export function DraftVacancyScheduleGrid({ schedule }: { schedule: NormalizedSchedule | null }) {
  const { t } = useTranslation();
  const days = buildScheduleGrid(schedule);

  return (
    <ul
      aria-label={t('admin.draftVacancy.schedule.ariaLabel')}
      className="grid grid-cols-4 sm:grid-cols-7 gap-1.5 list-none m-0 p-0"
    >
      {days.map((day) => {
        const isOff = day.blocks.length === 0;
        return (
          <li
            key={day.key}
            aria-label={isOff ? t('admin.draftVacancy.schedule.dayOffAria', { day: day.full }) : day.full}
            className={
              isOff
                ? 'flex flex-col items-center justify-start gap-0.5 rounded-lg border border-dashed border-gray-600 px-1 py-2'
                : 'flex flex-col items-center justify-start gap-0.5 rounded-lg bg-primary/10 px-1 py-2'
            }
          >
            <Text as="span" size="2xs" weight="medium" color={isOff ? 'muted' : 'primary'}>
              {day.short}
            </Text>
            {isOff ? (
              <Text as="span" size="xs" color="muted" aria-hidden="true">
                —
              </Text>
            ) : (
              day.blocks.map((block, i) => (
                <Text as="span" key={i} size="xs" weight="medium" color="secondary" className="whitespace-nowrap">
                  {formatScheduleTime(block.start)} a {formatScheduleTime(block.end)}
                </Text>
              ))
            )}
          </li>
        );
      })}
    </ul>
  );
}
