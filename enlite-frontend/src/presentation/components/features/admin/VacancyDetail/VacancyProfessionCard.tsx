import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';

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

// Map weekday keys to schedule object keys (backend uses various formats)
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
    <span className="bg-primary text-[#EDF2FE] font-lexend text-xs font-medium px-3 py-1 rounded tracking-[0.04px]">
      {slot.start}h - {slot.end}h
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
            <Typography
              variant="day-name"
              color="secondary"
              className="w-[103px] shrink-0"
            >
              {t(i18nKey)}
            </Typography>
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
}

function CharacteristicRow({ label, value }: CharacteristicRowProps) {
  return (
    <div className="flex gap-1.5 items-start">
      <Check
        className="text-cyan-focus shrink-0 mt-0.5"
        style={{ width: 18, height: 15 }}
        strokeWidth={2}
      />
      <Typography variant="label" color="secondary">
        {label}
      </Typography>
      {value != null && value !== '' && (
        <Typography variant="label" color="primary" weight="medium">
          {value}
        </Typography>
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
  serviceType: string | null;
  schedule: Record<string, TimeSlot[]> | null;
  onEdit?: () => void;
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
  onEdit,
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

  return (
    <div className="border-[2.5px] border-gray-400 rounded-card bg-white p-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex justify-between items-start">
        <Typography variant="card-title" color="primary" weight="semibold">
          {cardTitle}
        </Typography>
        {onEdit && (
          <Button
            variant="primary"
            size="md"
            onClick={onEdit}
            className="rounded-full shrink-0"
          >
            {t('admin.vacancyDetail.professionCard.edit')}
          </Button>
        )}
      </div>

      {/* Available for */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <Typography variant="label" color="secondary">
          {t('admin.vacancyDetail.professionCard.availableFor')}
        </Typography>
        <Typography variant="label" color="primary" weight="medium">
          {requiredSex ?? '—'}
        </Typography>
      </div>

      {/* Diagnosis */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <Typography variant="label" color="secondary">
          {t('admin.vacancyDetail.professionCard.diagnosis')}
        </Typography>
        <Typography variant="label" color="primary" weight="medium">
          {diagnosis ?? '—'}
        </Typography>
      </div>

      {/* Description */}
      {talentumDescription && (
        <div className="flex flex-col gap-2">
          <Typography
            variant="label"
            color="primary"
            weight="medium"
            className="font-lexend text-[18px] leading-[1.3]"
          >
            {t('admin.vacancyDetail.professionCard.description')}
          </Typography>
          <Typography variant="body" color="secondary" className="leading-[1.5]">
            {talentumDescription}
          </Typography>
        </div>
      )}

      {/* Characteristics */}
      <div className="flex flex-col gap-4">
        <Typography variant="section-title" color="primary" weight="medium">
          {t('admin.vacancyDetail.professionCard.characteristics')}
        </Typography>
        <div className="flex flex-col gap-2.5">
          <CharacteristicRow
            label={t('admin.vacancyDetail.professionCard.ageRange')}
            value={ageRange}
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
            value={serviceType}
          />
          <CharacteristicRow
            label={t('admin.vacancyDetail.professionCard.daysAndHours')}
            value={null}
          />
        </div>

        <ScheduleGrid schedule={schedule} />
      </div>
    </div>
  );
}
