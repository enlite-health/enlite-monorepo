/**
 * MeetLinksField
 *
 * 3 fixed Google Meet URL inputs used inside the vacancy form. On blur each
 * input is normalized (https:// auto-prepended) and the start datetime is
 * resolved via the backend `meet-links/lookup` endpoint — a thin wrapper over
 * the existing `googleCalendarService.resolveDateTime` routine (the same one
 * the PUT meet-links endpoint already uses to persist `meet_datetime_*`). No
 * persistence happens at this stage; the value is only stored in form state
 * and saved by the parent form's submit handler.
 *
 * Extracted from VacancyFormLeftColumn to keep that file under the 400-line
 * limit imposed by `feedback_line_limit_when_touching_file`.
 */

import { useState } from 'react';
import { Control, Controller, FieldErrors } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { FormField } from '@presentation/components/molecules/FormField/FormField';
import type { VacancyFormData } from '../vacancy-form-schema';
import {
  MEET_LINK_REGEX_LOOSE,
  MEET_LINK_REGEX,
  normalizeMeetLink,
} from '../vacancy-form-schema';

type MeetLookupState = 'idle' | 'loading' | 'found' | 'not_found' | 'invalid';
type LookupRow = { status: MeetLookupState; datetime: string | null };

interface MeetLinksFieldProps {
  control: Control<VacancyFormData>;
  errors: FieldErrors<VacancyFormData>;
}

const INITIAL_LOOKUPS: LookupRow[] = [
  { status: 'idle', datetime: null },
  { status: 'idle', datetime: null },
  { status: 'idle', datetime: null },
];

function formatMeetDatetime(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('es-AR', {
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

export function MeetLinksField({ control, errors }: MeetLinksFieldProps): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string) => t(`admin.vacancyModal.${k}`);
  const tf = (k: string) => t(`admin.vacancyDetail.vacancyForm.${k}`);

  const [lookups, setLookups] = useState<LookupRow[]>(INITIAL_LOOKUPS);

  const setLookupAt = (i: number, next: LookupRow) => {
    setLookups((prev) => prev.map((row, idx) => (idx === i ? next : row)));
  };

  return (
    <FormField
      label={tp('meetLinksLabel')}
      required
      error={errors.meet_links ? tf('validation.meetLinkRequired') : undefined}
    >
      <Controller
        name="meet_links"
        control={control}
        render={({ field }) => {
          const tuple = field.value as [string, string, string];

          const handleBlur = async (i: number) => {
            const raw = tuple[i] ?? '';
            const trimmed = raw.trim();
            if (!trimmed) {
              setLookupAt(i, { status: 'idle', datetime: null });
              return;
            }
            if (!MEET_LINK_REGEX_LOOSE.test(trimmed)) {
              setLookupAt(i, { status: 'invalid', datetime: null });
              return;
            }
            const normalized = normalizeMeetLink(trimmed);
            if (normalized !== raw) {
              const next: [string, string, string] = [...tuple] as [string, string, string];
              next[i] = normalized;
              field.onChange(next);
            }
            if (!MEET_LINK_REGEX.test(normalized)) {
              setLookupAt(i, { status: 'invalid', datetime: null });
              return;
            }
            setLookupAt(i, { status: 'loading', datetime: null });
            try {
              const result = await AdminApiService.lookupMeetDatetime(normalized);
              setLookupAt(i, {
                status: result.datetime ? 'found' : 'not_found',
                datetime: result.datetime,
              });
            } catch {
              setLookupAt(i, { status: 'not_found', datetime: null });
            }
          };

          return (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => {
                const value = tuple[i] ?? '';
                const lookup = lookups[i];
                const formattedDt = formatMeetDatetime(lookup.datetime);
                return (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="relative">
                      <input
                        type="text"
                        placeholder={tp('meetLinkPlaceholder')}
                        value={value}
                        onChange={(e) => {
                          const next: [string, string, string] = [...tuple] as [string, string, string];
                          next[i] = e.target.value;
                          field.onChange(next);
                          if (lookups[i].status !== 'idle') {
                            setLookupAt(i, { status: 'idle', datetime: null });
                          }
                        }}
                        onBlur={() => handleBlur(i)}
                        className="w-full h-[60px] rounded-[10px] border-2 border-[#d9d9d9] bg-white px-5 py-3 pr-12 font-['Lexend'] font-medium text-[20px] leading-[1.3] text-[#737373] placeholder:text-[#737373]/60 focus:border-[#180149] focus:outline-none transition-colors"
                        data-testid={`meet-link-${i}`}
                      />
                      {lookup.status === 'loading' && (
                        <Loader2
                          className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#737373] animate-spin"
                          aria-label="loading"
                        />
                      )}
                      {lookup.status === 'found' && (
                        <CheckCircle2
                          className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-green-500"
                          aria-label="meet found"
                        />
                      )}
                      {(lookup.status === 'not_found' || lookup.status === 'invalid') && (
                        <AlertCircle
                          className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-yellow-500"
                          aria-label="meet warning"
                        />
                      )}
                    </div>
                    {lookup.status === 'found' && formattedDt && (
                      <span
                        className="self-start px-2 py-0.5 bg-blue-50 text-blue-600 text-xs rounded-full"
                        data-testid={`meet-link-${i}-datetime`}
                      >
                        {formattedDt}
                      </span>
                    )}
                    {lookup.status === 'not_found' && (
                      <span
                        className="text-xs text-yellow-600"
                        data-testid={`meet-link-${i}-not-found`}
                      >
                        {tp('meetLinkNotFound')}
                      </span>
                    )}
                    {lookup.status === 'invalid' && (
                      <span
                        className="text-xs text-red-500"
                        data-testid={`meet-link-${i}-invalid`}
                      >
                        {tp('meetLinkInvalid')}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        }}
      />
    </FormField>
  );
}
