import { useTranslation } from 'react-i18next';
import { Typography } from '@presentation/components/atoms/Typography';

interface VacancyMeetLinksRowProps {
  meetLink1: string | null;
  meetDatetime1: string | null;
  meetLink2: string | null;
  meetDatetime2: string | null;
  meetLink3: string | null;
  meetDatetime3: string | null;
}

function formatMeetDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  try {
    return new Intl.DateTimeFormat('es-AR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(new Date(dateStr))
      .replace(':00', 'h')
      .replace(/:\d{2}$/, 'h');
  } catch {
    return null;
  }
}

interface MeetSlot {
  link: string | null;
  datetime: string | null;
}

function MeetDatePill({ slot }: { slot: MeetSlot }) {
  const label = formatMeetDate(slot.datetime) ?? slot.datetime ?? '';

  if (slot.link) {
    return (
      <a
        href={slot.link}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-primary text-[#EDF2FE] font-lexend text-base font-medium px-5 py-2 rounded inline-flex items-center hover:opacity-90 transition-opacity"
      >
        {label}
      </a>
    );
  }

  return (
    <span className="bg-primary text-[#EDF2FE] font-lexend text-base font-medium px-5 py-2 rounded inline-flex items-center">
      {label}
    </span>
  );
}

export function VacancyMeetLinksRow({
  meetLink1,
  meetDatetime1,
  meetLink2,
  meetDatetime2,
  meetLink3,
  meetDatetime3,
}: VacancyMeetLinksRowProps) {
  const { t } = useTranslation();

  const slots: MeetSlot[] = [
    { link: meetLink1, datetime: meetDatetime1 },
    { link: meetLink2, datetime: meetDatetime2 },
    { link: meetLink3, datetime: meetDatetime3 },
  ];

  const filledSlots = slots.filter((s) => s.link || s.datetime);

  if (filledSlots.length === 0) {
    return null;
  }

  return (
    <div className="border-[2.5px] border-gray-400 rounded-card bg-white p-6 flex flex-col gap-3 mb-5">
      <Typography variant="section-title" color="primary" weight="medium">
        {t('admin.vacancyDetail.meetLinksRow.title')}
      </Typography>
      <div className="flex flex-wrap gap-3">
        {filledSlots.map((slot, idx) => (
          <MeetDatePill key={idx} slot={slot} />
        ))}
      </div>
    </div>
  );
}
