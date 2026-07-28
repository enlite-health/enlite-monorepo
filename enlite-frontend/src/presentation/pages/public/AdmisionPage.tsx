import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Mail, Phone } from 'lucide-react';
import { Heading, Text, Button } from '@presentation/components/atoms';
import { FormField } from '@presentation/components/molecules/FormField';
import { SelectField } from '@presentation/components/molecules/SelectField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import {
  LeadsApiService,
  type LeadServiceType,
  type LeadRequesterType,
} from '@infrastructure/http/LeadsApiService';
import { resolveLeadSchedulingProvider } from './scheduling/LeadSchedulingProvider';

/**
 * AdmisionPage — public B2C patient intake (Task 1, decisão D4).
 *
 * Unauthenticated page (NOT under /admin). Four minimal fields → creates a
 * SOLICITANTE lead in Enlite via POST /api/public/v1/leads, then shows the
 * scheduling step (Google Appointment Schedule embed, D8). The WordPress
 * /registrar/admisión iframe will point its src here (E1, ops task).
 */

const SERVICE_TYPES: LeadServiceType[] = [
  'cuidadores',
  'acompanantes_terapeuticos',
  'psicologos',
];

function useLeadSchema() {
  const { t } = useTranslation();
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
};

export default function AdmisionPage(): JSX.Element {
  const { t } = useTranslation();
  const schema = useLeadSchema();

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<LeadFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { requesterType: 'patient' },
  });

  const scheduling = resolveLeadSchedulingProvider();

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
      });
      setLeadId(id);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('admission.form.submitError'));
    }
  });

  return (
    <main className="min-h-screen bg-[#F7F7FB] flex justify-center px-4 py-10">
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
          <section
            data-testid="lead-scheduling"
            className="rounded-[16px] bg-white p-6 shadow-sm flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1">
              <Heading level={2} weight="semibold" color="secondary">
                {t('admission.scheduling.title')}
              </Heading>
              <Text size="sm" color="muted">
                {t('admission.scheduling.subtitle')}
              </Text>
            </div>
            <scheduling.Component leadId={leadId} />
          </section>
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
              error={errors.serviceType?.message}
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
              error={errors.email?.message}
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
              error={errors.phone?.message}
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
