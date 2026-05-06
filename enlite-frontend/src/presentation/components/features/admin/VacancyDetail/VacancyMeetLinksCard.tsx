import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertCircle, Circle, Loader2, ExternalLink } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

const MEET_LINK_REGEX = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

interface Props {
  vacancyId: string;
  meetLink1: string | null;
  meetDatetime1: string | null;
  meetLink2: string | null;
  meetDatetime2: string | null;
  meetLink3: string | null;
  meetDatetime3: string | null;
  onSaved: () => void;
}

interface LinkRow {
  link: string;
  datetime: string | null;
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
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<LinkRow[]>([
    { link: meetLink1 ?? '', datetime: meetDatetime1 },
    { link: meetLink2 ?? '', datetime: meetDatetime2 },
    { link: meetLink3 ?? '', datetime: meetDatetime3 },
  ]);
  const [errors, setErrors] = useState<[string, string, string]>(['', '', '']);
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
    return valid;
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
      await AdminApiService.updateVacancyMeetLinks(vacancyId, payload);
      setFeedback({ type: 'success', message: t('admin.vacancyDetail.meetLinksCard.saveSuccess') });
      onSaved();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('admin.vacancyDetail.meetLinksCard.saveError');
      setFeedback({ type: 'error', message });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
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
                <label className="text-sm font-medium text-slate-700">{label}</label>
                {formatted && (
                  <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-xs rounded-full whitespace-nowrap">
                    {formatted}
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
                <span className="text-xs text-red-500">{errors[i]}</span>
              )}
            </div>
          );
        })}
      </div>

      {feedback && (
        <div
          className={`rounded-lg px-4 py-2.5 text-sm ${
            feedback.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {feedback.message}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 px-5"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {isSaving ? t('admin.vacancyDetail.meetLinksCard.saving') : t('admin.vacancyDetail.meetLinksCard.saveLinks')}
        </Button>
      </div>
    </div>
  );
}
