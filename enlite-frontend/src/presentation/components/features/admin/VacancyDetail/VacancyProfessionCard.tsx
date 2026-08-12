import { useTranslation } from 'react-i18next';
import { Check, Pencil } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

type WeekdayKey =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

const WEEKDAY_KEYS: WeekdayKey[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const SCHEDULE_KEY_MAP: Record<WeekdayKey, string[]> = {
  sunday: ['sunday', 'domingo', '0'],
  monday: ['monday', 'lunes', '1'],
  tuesday: ['tuesday', 'martes', '2'],
  wednesday: ['wednesday', 'miercoles', 'miércoles', '3'],
  thursday: ['thursday', 'jueves', '4'],
  friday: ['friday', 'viernes', '5'],
  saturday: ['saturday', 'sabado', 'sábado', '6'],
};

interface TimeSlot {
  start: string;
  end: string;
}

interface ScheduleGridProps {
  schedule: Record<string, TimeSlot[]> | null;
}

function SchedulePill({ slot }: { slot: TimeSlot }) {
  return (
    <span className="bg-primary text-[#EDF2FE] px-3 py-1 rounded tracking-[0.04px]">
      <Text as="span" size="xs" weight="medium" color="inherit">
        {slot.start}h - {slot.end}h
      </Text>
    </span>
  );
}

function ScheduleGrid({ schedule }: ScheduleGridProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      {WEEKDAY_KEYS.map((weekdayKey) => {
        const i18nKey = `admin.vacancyDetail.professionCard.weekdays.${weekdayKey}`;
        const slots: TimeSlot[] = [];

        if (schedule) {
          for (const alias of SCHEDULE_KEY_MAP[weekdayKey]) {
            if (schedule[alias]?.length) {
              slots.push(...schedule[alias]);
              break;
            }
          }
        }

        return (
          <div key={weekdayKey} className="flex items-center gap-2">
            <Text size="sm" color="secondary" className="w-[103px] shrink-0">
              {t(i18nKey)}
            </Text>
            <div className="flex flex-wrap gap-2">
              {slots.map((slot, idx) => (
                <SchedulePill key={idx} slot={slot} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface CharacteristicRowProps {
  label: string;
  value: string | null | undefined;
  placeholder?: string;
}

function CharacteristicRow({ label, value, placeholder }: CharacteristicRowProps) {
  const display = value != null && value !== '' ? value : placeholder;
  return (
    <div className="flex gap-1.5 items-start">
      <Check
        className="text-cyan-focus shrink-0 mt-0.5"
        style={{ width: 18, height: 15 }}
        strokeWidth={2}
      />
      <Text as="span" size="base" color="secondary">
        {label}
      </Text>
      {display && (
        <Text as="span" size="base" color="primary" weight="medium">
          {display}
        </Text>
      )}
    </div>
  );
}

interface VacancyProfessionCardProps {
  profession: string | null;
  requiredSex: string | null;
  diagnosis: string | null;
  talentumDescription: string | null;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  zone: string | null;
  workerAttributes: string | null;
  serviceType: string[] | null;
  schedule: Record<string, TimeSlot[]> | null;
  onEditSchedule?: () => void;
  onEditDescription?: () => void;
}

export function VacancyProfessionCard({
  profession,
  requiredSex,
  diagnosis,
  talentumDescription,
  ageRangeMin,
  ageRangeMax,
  zone,
  workerAttributes,
  serviceType,
  schedule,
  onEditSchedule,
  onEditDescription,
}: VacancyProfessionCardProps) {
  const { t } = useTranslation();

  const isCaregiver =
    profession?.toUpperCase() === 'CAREGIVER' ||
    profession?.toUpperCase() === 'CUIDADOR';

  const cardTitle = isCaregiver
    ? t('admin.vacancyDetail.professionCard.titleCaregiver')
    : t('admin.vacancyDetail.professionCard.title');

  const ageRange =
    ageRangeMin != null || ageRangeMax != null
      ? [ageRangeMin, ageRangeMax].filter((v) => v != null).join(' - ')
      : null;

  const ageRangePlaceholder = t('admin.vacancyDetail.professionCard.ageRangeAny');

  const serviceTypeArray: string[] = Array.isArray(serviceType)
    ? serviceType
    : typeof serviceType === 'string' && serviceType
      ? (serviceType as string).split(',').map((s) => s.trim()).filter(Boolean)
      : [];

  const serviceTypeLabel =
    serviceTypeArray.length > 0
      ? serviceTypeArray
          .map((svc) =>
            t(`admin.patients.detail.contractedServicesCard.serviceTypes.${svc}`, svc),
          )
          .join(', ')
      : null;

  return (
    <div className="border-[2.5px] border-gray-400 rounded-card bg-white p-8 flex flex-col gap-6">
      <div className="flex justify-between items-start">
        <Heading level={1} color="primary" weight="semibold">
          {cardTitle}
        </Heading>
      </div>

      <div className="flex items-baseline gap-2 flex-wrap">
        <Text as="span" size="base" color="secondary">
          {t('admin.vacancyDetail.professionCard.availableFor')}
        </Text>
        <Text as="span" size="base" color="primary" weight="medium">
          {requiredSex
            ? t(
                `admin.vacancyDetail.vacancyForm.sexOptions.${requiredSex}`,
                requiredSex,
              )
            : '—'}
        </Text>
      </div>

      <div className="flex items-baseline gap-2 flex-wrap">
        <Text as="span" size="base" color="secondary">
          {t('admin.vacancyDetail.professionCard.diagnosis')}
        </Text>
        <Text as="span" size="base" color="primary" weight="medium">
          {diagnosis ?? '—'}
        </Text>
      </div>

      {(talentumDescription || onEditDescription) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Text size="base" color="primary" weight="medium">
              {t('admin.vacancyDetail.professionCard.description')}
            </Text>
            {onEditDescription && (
              <button
                type="button"
                onClick={onEditDescription}
                aria-label={t('admin.vacancyDetail.professionCard.editDescription')}
                data-testid="vacancy-edit-description-trigger"
                className="text-primary hover:text-primary/70 transition-colors p-1 rounded"
              >
                <Pencil className="w-4 h-4" strokeWidth={2} />
              </button>
            )}
          </div>
          <Text size="sm" color="secondary" className="leading-[1.5] whitespace-pre-line">
            {talentumDescription || t('admin.vacancyDetail.professionCard.descriptionEmpty')}
          </Text>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Heading level={2} color="primary" weight="medium">
          {t('admin.vacancyDetail.professionCard.characteristics')}
        </Heading>
        <div className="flex flex-col gap-2.5">
          <CharacteristicRow
            label={t('admin.vacancyDetail.professionCard.ageRange')}
            value={ageRange}
            placeholder={ageRangePlaceholder}
          />
          <CharacteristicRow
            label={t('admin.vacancyDetail.professionCard.location')}
            value={zone}
          />
          <CharacteristicRow
            label={t('admin.vacancyDetail.professionCard.profile')}
            value={workerAttributes}
          />
          <CharacteristicRow
            label={t('admin.vacancyDetail.professionCard.serviceType')}
            value={serviceTypeLabel}
          />
          <div className="flex items-center justify-between gap-2">
            <CharacteristicRow
              label={t('admin.vacancyDetail.professionCard.daysAndHours')}
              value={null}
            />
            {onEditSchedule && (
              <button
                type="button"
                onClick={onEditSchedule}
                aria-label={t('admin.vacancyDetail.professionCard.editSchedule')}
                data-testid="vacancy-edit-schedule-trigger"
                className="text-primary hover:text-primary/70 transition-colors p-1 rounded"
              >
                <Pencil className="w-4 h-4" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>

        <ScheduleGrid schedule={schedule} />
      </div>
    </div>
  );
}
