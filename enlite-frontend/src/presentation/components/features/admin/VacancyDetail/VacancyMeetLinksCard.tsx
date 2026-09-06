import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertCircle, Circle, Loader2, ExternalLink, Repeat } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { Select } from '@presentation/components/atoms/Select';
import { AdminApiService, type RecurringMeetSlot } from '@infrastructure/http/AdminApiService';
import { toInputTime } from './meetRecurringUtils';

const MEET_LINK_REGEX = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

interface Props {
  vacancyId: string;
  meetLink1: string | null;
  meetDatetime1: string | null;
  meetLink2: string | null;
  meetDatetime2: string | null;
  meetLink3: string | null;
  meetDatetime3: string | null;
  /** Slot RECORRENTE (mig 291): 0=domingo … 6=sábado; hora LOCAL da vaga ('HH:MM' ou 'HH:MM:SS'). */
  recurringWeekday?: number | null;
  recurringTime?: string | null;
  recurringLink?: string | null;
  onSaved: () => void;
}

interface LinkRow {
  link: string;
  datetime: string | null;
}

interface RecurringForm {
  weekday: string; // '' | '0'..'6'
  time: string;    // 'HH:MM'
  link: string;
}

function formatDatetime(dateStr: string | null): string | null {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleString('es-AR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

function LinkStatusIcon({ link, datetime }: { link: string; datetime: string | null }) {
  if (link && datetime) {
    return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />;
  }
  if (link && !datetime) {
    return <AlertCircle className="w-4 h-4 text-yellow-500 shrink-0" />;
  }
  return <Circle className="w-4 h-4 text-slate-300 shrink-0" />;
}

export function VacancyMeetLinksCard({
  vacancyId,
  meetLink1,
  meetDatetime1,
  meetLink2,
  meetDatetime2,
  meetLink3,
  meetDatetime3,
  recurringWeekday = null,
  recurringTime = null,
  recurringLink = null,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<LinkRow[]>([
    { link: meetLink1 ?? '', datetime: meetDatetime1 },
    { link: meetLink2 ?? '', datetime: meetDatetime2 },
    { link: meetLink3 ?? '', datetime: meetDatetime3 },
  ]);
  const [errors, setErrors] = useState<[string, string, string]>(['', '', '']);
  const initialRecurring: RecurringForm = {
    weekday: recurringWeekday === null || recurringWeekday === undefined ? '' : String(recurringWeekday),
    time: toInputTime(recurringTime),
    link: recurringLink ?? '',
  };
  const [recurring, setRecurring] = useState<RecurringForm>(initialRecurring);
  const [recurringError, setRecurringError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleLinkChange = (index: number, value: string) => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, link: value } : row)));
    if (errors[index]) {
      setErrors(prev => {
        const next: [string, string, string] = [...prev] as [string, string, string];
        next[index] = '';
        return next;
      });
    }
    setFeedback(null);
  };

  const handleRecurringChange = (patch: Partial<RecurringForm>) => {
    setRecurring(prev => ({ ...prev, ...patch }));
    setRecurringError('');
    setFeedback(null);
  };

  const validate = (): boolean => {
    const next: [string, string, string] = ['', '', ''];
    let valid = true;
    rows.forEach((row, i) => {
      const trimmed = row.link.trim();
      if (trimmed && !MEET_LINK_REGEX.test(trimmed)) {
        next[i] = t('admin.vacancyDetail.meetLinksCard.invalidLink');
        valid = false;
      }
    });
    setErrors(next);

    // Recorrente: ou tudo vazio (limpa) ou tudo preenchido e válido.
    const r = { weekday: recurring.weekday, time: recurring.time.trim(), link: recurring.link.trim() };
    const anyFilled = r.weekday !== '' || r.time !== '' || r.link !== '';
    const allFilled = r.weekday !== '' && r.time !== '' && r.link !== '';
    if (anyFilled && !allFilled) {
      setRecurringError(t('admin.vacancyDetail.meetRecurring.incomplete'));
      valid = false;
    } else if (allFilled && !MEET_LINK_REGEX.test(r.link)) {
      // A hora vem de <input type="time"> — o navegador só entrega HH:MM (o backend revalida).
      setRecurringError(t('admin.vacancyDetail.meetLinksCard.invalidLink'));
      valid = false;
    } else {
      setRecurringError('');
    }
    return valid;
  };

  /** O que mandar em `recurring`: undefined = não mudou; null = limpar; objeto = gravar. */
  const recurringPayload = (): RecurringMeetSlot | null | undefined => {
    const r = { weekday: recurring.weekday, time: recurring.time.trim(), link: recurring.link.trim() };
    const same = r.weekday === initialRecurring.weekday && r.time === initialRecurring.time && r.link === initialRecurring.link;
    if (same) return undefined;
    if (r.weekday === '' && r.time === '' && r.link === '') return null;
    return { weekday: Number(r.weekday), time: r.time, link: r.link };
  };

  const handleSave = async () => {
    if (!validate()) return;

    const payload: [string | null, string | null, string | null] = [
      rows[0].link.trim() || null,
      rows[1].link.trim() || null,
      rows[2].link.trim() || null,
    ];

    try {
      setIsSaving(true);
      setFeedback(null);
      await AdminApiService.updateVacancyMeetLinks(vacancyId, payload, recurringPayload());
      setFeedback({ type: 'success', message: t('admin.vacancyDetail.meetLinksCard.saveSuccess') });
      onSaved();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('admin.vacancyDetail.meetLinksCard.saveError');
      setFeedback({ type: 'error', message });
    } finally {
      setIsSaving(false);
    }
  };

  const weekdayOptions = [
    { value: '', label: t('admin.vacancyDetail.meetRecurring.none') },
    ...['1', '2', '3', '4', '5', '6', '0'].map((d) => ({ value: d, label: t(`admin.vacancyDetail.meetRecurring.daysShort.${d}`) })),
  ];

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4" data-testid="vacancy-meet-links-card">
      <Heading level={3} weight="semibold" color="secondary">
        {t('admin.vacancyDetail.meetLinksCard.title')}
      </Heading>

      <div className="flex flex-col gap-4">
        {rows.map((row, i) => {
          const label = `Link ${i + 1}`;
          const formatted = formatDatetime(row.datetime);
          return (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <LinkStatusIcon link={row.link} datetime={row.datetime} />
                <Text as="span" size="sm" weight="medium">{label}</Text>
                {formatted && (
                  <span className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full whitespace-nowrap">
                    <Text as="span" size="xs" color="inherit">{formatted}</Text>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="url"
                  value={row.link}
                  onChange={e => handleLinkChange(i, e.target.value)}
                  placeholder="https://meet.google.com/xxx-xxxx-xxx"
                  className={`flex-1 border rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                    errors[i] ? 'border-red-400' : 'border-[#D9D9D9]'
                  }`}
                />
                {row.link.trim() && (
                  <a
                    href={row.link.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#737373] hover:text-primary transition-colors shrink-0"
                    title={t('admin.vacancyDetail.meetLinksCard.openLink')}
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </div>
              {errors[i] && (
                <Text as="span" size="xs" color="inherit" className="text-red-500">{errors[i]}</Text>
              )}
            </div>
          );
        })}
      </div>

      {/* Slot RECORRENTE — a reunión de presentación é semanal (D211.4) */}
      <div className="border-t border-slate-200 pt-4 flex flex-col gap-2" data-testid="meet-recurring">
        <div className="flex items-center gap-2">
          <Repeat className="w-4 h-4 text-slate-500 shrink-0" />
          <Text as="span" size="sm" weight="medium">{t('admin.vacancyDetail.meetRecurring.title')}</Text>
        </div>
        <Text size="xs" color="secondary">{t('admin.vacancyDetail.meetRecurring.hint')}</Text>
        <div className="grid grid-cols-1 md:grid-cols-[160px_120px_1fr] gap-2">
          <Select
            data-testid="meet-recurring-weekday"
            options={weekdayOptions}
            value={recurring.weekday}
            onValueChange={(v) => handleRecurringChange({ weekday: v })}
            aria-label={t('admin.vacancyDetail.meetRecurring.weekday')}
          />
          <input
            type="time"
            data-testid="meet-recurring-time"
            value={recurring.time}
            onChange={(e) => handleRecurringChange({ time: e.target.value })}
            aria-label={t('admin.vacancyDetail.meetRecurring.time')}
            className="border rounded-lg px-3 py-2 text-sm text-slate-700 bg-white border-[#D9D9D9] focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <input
            type="url"
            data-testid="meet-recurring-link"
            value={recurring.link}
            onChange={(e) => handleRecurringChange({ link: e.target.value })}
            placeholder="https://meet.google.com/xxx-xxxx-xxx"
            aria-label={t('admin.vacancyDetail.meetRecurring.link')}
            className={`border rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 ${recurringError ? 'border-red-400' : 'border-[#D9D9D9]'}`}
          />
        </div>
        {recurringError && (
          <span className="text-red-500" data-testid="meet-recurring-error">
            <Text as="span" size="xs" color="inherit">{recurringError}</Text>
          </span>
        )}
      </div>

      {feedback && (
        <div
          className={`rounded-lg px-4 py-2.5 ${
            feedback.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
          data-testid="meet-links-feedback"
        >
          <Text as="span" size="sm" color="inherit">{feedback.message}</Text>
        </div>
      )}

      <div className="flex justify-end">
        {/* PUT /vacancies/:id/meet-links → updateVacancyMeetLinks → vacancy:write. */}
        <ActionButton
          resource="vacancy"
          action="write"
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 px-5"
          data-testid="meet-links-save"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {isSaving ? t('admin.vacancyDetail.meetLinksCard.saving') : t('admin.vacancyDetail.meetLinksCard.saveLinks')}
        </ActionButton>
      </div>
    </div>
  );
}
