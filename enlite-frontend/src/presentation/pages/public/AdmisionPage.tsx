import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Mail, Phone, Calendar, Video, CheckCircle2 } from 'lucide-react';
import { Heading, Text, Button } from '@presentation/components/atoms';
import { FormField } from '@presentation/components/molecules/FormField';
import { SelectField } from '@presentation/components/molecules/SelectField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import {
  LeadsApiService,
  AdmissionApiError,
  type LeadServiceType,
  type LeadRequesterType,
  type AdmissionCountry,
  type AdmissionSlot,
  type BookAdmissionResult,
} from '@infrastructure/http/LeadsApiService';

/**
 * AdmisionPage — public B2C patient intake (Task 1 → Task 2, native slot picker).
 *
 * Unauthenticated page (NOT under /admin). Parametrized by `country` (AR|BR):
 * the same page serves /admission-ar (es) and /admission-br (pt-BR), forcing the
 * page language regardless of the global i18n language.
 *
 * Three steps:
 *   1. Form (4 fields) → POST /api/public/v1/leads → keeps the returned leadId.
 *   2. Slot picker → GET /admission/slots?country → pick → POST /admission/book.
 *   3. Confirmation → shows host, datetime, Meet link (+ WhatsApp notice).
 */

export interface AdmisionPageProps {
  country: AdmissionCountry;
}

const SERVICE_TYPES: LeadServiceType[] = [
  'cuidadores',
  'acompanantes_terapeuticos',
  'psicologos',
];

/** Page language + tz/locale for datetime grouping, keyed by country. */
const COUNTRY_LANG: Record<AdmissionCountry, string> = { AR: 'es', BR: 'pt-BR' };
const COUNTRY_TZ: Record<AdmissionCountry, string> = {
  AR: 'America/Argentina/Buenos_Aires',
  BR: 'America/Sao_Paulo',
};
const COUNTRY_LOCALE: Record<AdmissionCountry, string> = { AR: 'es-AR', BR: 'pt-BR' };

function useLeadSchema(t: TFunction) {
  return useMemo(
    () =>
      z.object({
        serviceType: z.enum(['cuidadores', 'acompanantes_terapeuticos', 'psicologos'], {
          errorMap: () => ({ message: t('admission.form.serviceType.required') }),
        }),
        requesterType: z.enum(['patient', 'responsible'], {
          errorMap: () => ({ message: t('admission.form.requesterType.required') }),
        }),
        email: z
          .string()
          .trim()
          .min(1, { message: t('admission.form.email.required') })
          .email({ message: t('admission.form.email.invalid') }),
        phone: z
          .string()
          .trim()
          .min(6, { message: t('admission.form.phone.required') }),
        name: z.string().trim().optional(),
        consent: z.boolean().refine((v) => v === true, {
          message: t('admission.form.consent.required'),
        }),
      }),
    [t],
  );
}

type LeadFormValues = {
  serviceType: LeadServiceType;
  requesterType: LeadRequesterType;
  email: string;
  phone: string;
  name?: string;
  consent: boolean;
};

export default function AdmisionPage({ country }: AdmisionPageProps): JSX.Element {
  const { i18n } = useTranslation();
  // Force the page language by country, independent of the global language.
  const t = useMemo(() => i18n.getFixedT(COUNTRY_LANG[country]), [i18n, country]);
  const schema = useLeadSchema(t);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LeadFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { requesterType: 'patient', consent: false },
  });

  const consentChecked = watch('consent');

  const serviceOptions = SERVICE_TYPES.map((value) => ({
    value,
    label: t(`admission.services.${value}`),
  }));

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const { id } = await LeadsApiService.createLead({
        serviceType: values.serviceType,
        requesterType: values.requesterType,
        email: values.email,
        phone: values.phone,
        name: values.name?.trim() || undefined,
        country,
        consent: values.consent,
      });
      setLeadId(id);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('admission.form.submitError'));
    }
  });

  return (
    <main
      className="min-h-screen bg-[#F7F7FB] flex justify-center px-4 py-10"
      data-testid="admission-country"
      data-country={country}
    >
      <div className="w-full max-w-[560px] flex flex-col gap-8">
        <header className="flex flex-col gap-2 text-center">
          <Heading level={1} weight="bold" color="primary">
            {t('admission.title')}
          </Heading>
          <Text size="base" color="muted">
            {t('admission.subtitle')}
          </Text>
        </header>

        {leadId ? (
          <AdmissionScheduling country={country} leadId={leadId} t={t} />
        ) : (
          <form
            onSubmit={onSubmit}
            noValidate
            data-testid="lead-form"
            className="rounded-[16px] bg-white p-6 shadow-sm flex flex-col gap-5"
          >
            <FormField
              label={t('admission.form.serviceType.label')}
              required
            >
              <Controller
                control={control}
                name="serviceType"
                render={({ field }) => (
                  <SelectField
                    data-testid="lead-serviceType"
                    options={serviceOptions}
                    placeholder={t('admission.form.serviceType.placeholder')}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    error={errors.serviceType?.message}
                  />
                )}
              />
            </FormField>

            <FormField
              label={t('admission.form.requesterType.label')}
              required
              error={errors.requesterType?.message}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="patient"
                    data-testid="lead-requesterType-patient"
                    className="h-4 w-4 accent-primary"
                    {...register('requesterType')}
                  />
                  <Text as="span" size="sm" color="secondary">
                    {t('admission.form.requesterType.patient')}
                  </Text>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="responsible"
                    data-testid="lead-requesterType-responsible"
                    className="h-4 w-4 accent-primary"
                    {...register('requesterType')}
                  />
                  <Text as="span" size="sm" color="secondary">
                    {t('admission.form.requesterType.responsible')}
                  </Text>
                </label>
              </div>
            </FormField>

            <FormField
              label={t('admission.form.email.label')}
              required
            >
              <InputWithIcon
                data-testid="lead-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder={t('admission.form.email.placeholder')}
                icon={<Mail size={20} className="text-[#737373]" />}
                error={errors.email?.message}
                {...register('email')}
              />
            </FormField>

            <FormField
              label={t('admission.form.phone.label')}
              required
            >
              <InputWithIcon
                data-testid="lead-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder={t('admission.form.phone.placeholder')}
                icon={<Phone size={20} className="text-[#737373]" />}
                error={errors.phone?.message}
                {...register('phone')}
              />
            </FormField>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="lead-consent"
                className="mt-1 h-4 w-4 accent-primary"
                {...register('consent')}
              />
              <Text as="span" size="sm" color="secondary">
                {t('admission.form.consent.label')}
              </Text>
            </label>
            {errors.consent && (
              <Text size="xs" className="text-red-500" data-testid="lead-consent-error">
                {errors.consent.message}
              </Text>
            )}

            {submitError && (
              <div
                data-testid="lead-submit-error"
                className="rounded-[10px] border-2 border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {submitError}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              isLoading={isSubmitting}
              disabled={!consentChecked}
              data-testid="lead-submit"
            >
              {t('admission.form.submit')}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}

/** Step 2 + 3: native slot picker → booking → confirmation. */
interface AdmissionSchedulingProps {
  country: AdmissionCountry;
  leadId: string;
  t: TFunction;
}

interface DayGroup {
  key: string;
  heading: string;
  slots: AdmissionSlot[];
}

function groupSlotsByDay(slots: AdmissionSlot[], country: AdmissionCountry): DayGroup[] {
  const tz = COUNTRY_TZ[country];
  const locale = COUNTRY_LOCALE[country];
  const keyFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const headingFmt = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();
  for (const slot of slots) {
    const date = new Date(slot.startISO);
    // Guard against unparseable ISO — fall back to the raw string as its own group.
    const validDate = !Number.isNaN(date.getTime());
    const key = validDate ? keyFmt.format(date) : slot.startISO;
    let group = index.get(key);
    if (!group) {
      group = { key, heading: validDate ? headingFmt.format(date) : slot.startISO, slots: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.slots.push(slot);
  }
  return groups;
}

function AdmissionScheduling({ country, leadId, t }: AdmissionSchedulingProps): JSX.Element {
  const [slots, setSlots] = useState<AdmissionSlot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<BookAdmissionResult | null>(null);

  const loadSlots = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await LeadsApiService.getAdmissionSlots(country);
      setSlots(result);
    } catch {
      setSlots(null);
      setLoadError(t('admission.slots.loadError'));
    } finally {
      setLoading(false);
    }
  }, [country, t]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  const onSelect = useCallback(
    async (slot: AdmissionSlot) => {
      if (booking) return;
      setBooking(true);
      setBookingError(null);
      try {
        const result = await LeadsApiService.bookAdmission({
          patientId: leadId,
          slotStartISO: slot.startISO,
          country,
        });
        setConfirmation(result);
      } catch (err) {
        if (err instanceof AdmissionApiError && err.code === 'SLOT_TAKEN') {
          setBookingError(t('admission.slots.slotTaken'));
          // The slot vanished under us — refresh the list so the user picks again.
          await loadSlots();
        } else {
          setBookingError(t('admission.slots.bookError'));
        }
      } finally {
        setBooking(false);
      }
    },
    [booking, leadId, country, t, loadSlots],
  );

  if (confirmation) {
    return <AdmissionConfirmation country={country} result={confirmation} t={t} />;
  }

  const dayGroups = slots ? groupSlotsByDay(slots, country) : [];
  const isEmpty = !loading && !loadError && dayGroups.length === 0;

  return (
    <section
      data-testid="slot-picker"
      className="rounded-[16px] bg-white p-6 shadow-sm flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <Heading level={2} weight="semibold" color="secondary">
          {t('admission.slots.title')}
        </Heading>
        <Text size="sm" color="muted">
          {t('admission.slots.subtitle')}
        </Text>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-3 py-8 text-[#737373]">
          <span className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
          <Text size="sm" color="muted">
            {t('admission.slots.loading')}
          </Text>
        </div>
      )}

      {loadError && (
        <div className="flex flex-col gap-3">
          <div
            data-testid="booking-error"
            className="rounded-[10px] border-2 border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {loadError}
          </div>
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => void loadSlots()}
            data-testid="slot-retry"
          >
            {t('admission.slots.retry')}
          </Button>
        </div>
      )}

      {isEmpty && (
        <div
          data-testid="slot-empty"
          className="rounded-[10px] border-2 border-dashed border-[#D9D9D9] bg-[#FAFAFA] px-4 py-8 text-center text-sm text-[#737373]"
        >
          {t('admission.slots.empty')}
        </div>
      )}

      {!loading && !loadError && dayGroups.length > 0 && (
        <div className="flex flex-col gap-5">
          {bookingError && (
            <div
              data-testid="booking-error"
              className="rounded-[10px] border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              {bookingError}
            </div>
          )}

          {dayGroups.map((group) => (
            <div key={group.key} className="flex flex-col gap-2">
              <Text as="span" size="sm" weight="semibold" color="secondary" className="capitalize">
                {group.heading}
              </Text>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {group.slots.map((slot) => (
                  <button
                    key={slot.startISO}
                    type="button"
                    disabled={booking}
                    onClick={() => void onSelect(slot)}
                    data-testid={`slot-option-${slot.startISO}`}
                    data-slot-iso={slot.startISO}
                    className="rounded-[10px] border-2 border-[#E5E5EF] bg-white px-3 py-2 text-sm text-[#333] transition-colors hover:border-primary hover:bg-[#F5F3FF] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {slot.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {booking && (
            <Text size="sm" color="muted" className="text-center">
              {t('admission.slots.booking')}
            </Text>
          )}
        </div>
      )}
    </section>
  );
}

/** Step 3: booking confirmation. */
interface AdmissionConfirmationProps {
  country: AdmissionCountry;
  result: BookAdmissionResult;
  t: TFunction;
}

function AdmissionConfirmation({ country, result, t }: AdmissionConfirmationProps): JSX.Element {
  const datetime = useMemo(() => {
    const date = new Date(result.slotStartISO);
    if (Number.isNaN(date.getTime())) return result.slotStartISO;
    return new Intl.DateTimeFormat(COUNTRY_LOCALE[country], {
      timeZone: COUNTRY_TZ[country],
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }, [result.slotStartISO, country]);

  return (
    <section
      data-testid="booking-confirmation"
      className="rounded-[16px] bg-white p-6 shadow-sm flex flex-col gap-5"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <CheckCircle2 size={40} className="text-green-600" />
        <Heading level={2} weight="semibold" color="secondary">
          {t('admission.confirmation.title')}
        </Heading>
      </div>

      <dl className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[#9A9A9A]">
            {t('admission.confirmation.hostLabel')}
          </dt>
          <dd data-testid="confirmation-host-name" className="text-sm font-medium text-[#333]">
            {result.hostDisplayName}
          </dd>
        </div>

        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[#9A9A9A]">
            {t('admission.confirmation.datetimeLabel')}
          </dt>
          <dd
            data-testid="confirmation-datetime"
            data-slot-iso={result.slotStartISO}
            className="flex items-center gap-2 text-sm font-medium text-[#333] capitalize"
          >
            <Calendar size={16} className="text-[#737373]" />
            {datetime}
          </dd>
        </div>

        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-[#9A9A9A]">
            {t('admission.confirmation.meetLabel')}
          </dt>
          <dd>
            <a
              data-testid="confirmation-meet-link"
              href={result.meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm font-medium text-primary underline break-all"
            >
              <Video size={16} />
              {t('admission.confirmation.joinMeet')}
            </a>
          </dd>
        </div>
      </dl>

      <div className="rounded-[10px] border-2 border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        {t('admission.confirmation.whatsapp')}
      </div>
    </section>
  );
}
