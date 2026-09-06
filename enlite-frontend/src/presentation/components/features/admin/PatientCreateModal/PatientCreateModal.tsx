import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { CreatePatientPayload } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { getCountryOptions } from '@presentation/pages/admin/patientsData';

interface PatientCreateModalProps {
  onClose: () => void;
  /** Called with the created patient id after a successful save. */
  onCreated: (patientId: string) => void;
}

const DOCUMENT_TYPES = ['DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF'] as const;
const SERVICE_TYPES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
const CLOSE_MS = 300;

// Mirrors the backend zod validator (createPatientSchema). Only firstName is
// required; empty optional strings are coerced to undefined so we never send "".
// Todo campo nasce preenchido em `defaultValues` ('' / []) — o tipo diz isso e o submit não carrega
// fallbacks para um `undefined` que nunca chega (mesmo padrão dos drawers, spec 011/012).
const createSchema = z.object({
  firstName: z.string().trim().min(1),
  // `country` sem default de propósito — decide o regime legal (Ley 25.326 vs LGPD) e o
  // filtro de país do painel; o operador escolhe (abac-pais-fase1 5.1). Placeholder vazio
  // falha o enum e mostra o erro inline em vez de mandar um corpo que o backend recusaria.
  country: z.enum(['AR', 'BR']),
  lastName: z.string().trim(),
  /** US-B6 (spec 012): yyyy-MM-dd. */
  birthDate: z.string(),
  phoneWhatsapp: z.string().trim(),
  contactEmail: z.union([z.literal(''), z.string().trim().email()]),
  documentType: z.string(),
  documentNumber: z.string().trim(),
  healthInsuranceName: z.string().trim(),
  healthInsuranceMemberId: z.string().trim(),
  serviceType: z.array(z.string()),
});

type CreateFormValues = z.infer<typeof createSchema>;

/**
 * Manual creation of a patient by the admission team (Fase 1 Task 2) — side
 * drawer, same design-system pattern as WorkerEditModal. Posts to
 * POST /api/admin/patients (origin=admin_manual, status=ADMISSION). The
 * contact-channel invariant is enforced by the backend; its 400 message is
 * shown inline here.
 */
export function PatientCreateModal({ onClose, onCreated }: PatientCreateModalProps): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.create.${k}`);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      firstName: '',
      // No preselected country on purpose — the operator must pick one, so a BR
      // patient is never filed as AR by inertia (abac-pais-fase1 5.1).
      country: undefined,
      lastName: '',
      birthDate: '',
      phoneWhatsapp: '',
      contactEmail: '',
      documentType: '',
      documentNumber: '',
      healthInsuranceName: '',
      healthInsuranceMemberId: '',
      serviceType: [],
    },
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => {
    setShow(false);
    setTimeout(onClose, CLOSE_MS);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const documentTypeOptions: SelectOption[] = DOCUMENT_TYPES.map((d) => ({
    value: d,
    label: t(`admin.patients.detail.documentTypes.${d}`, { defaultValue: d }),
  }));
  const serviceTypeOptions: SelectOption[] = SERVICE_TYPES.map((s) => ({
    value: s,
    label: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${s}`, { defaultValue: s }),
  }));
  // Same AR|BR source the panel's country FILTER uses, so the values a patient
  // can be created with always match the values it can be filtered by.
  const countryOptions: SelectOption[] = getCountryOptions(t);

  const onSubmit = async (values: CreateFormValues): Promise<void> => {
    setSubmitError(null);

    // Trim + drop empty optionals so the backend receives clean, minimal data.
    const clean = (v: string): string | undefined => {
      const s = v.trim();
      return s ? s : undefined;
    };
    const payload: CreatePatientPayload = {
      firstName: values.firstName.trim(),
      country: values.country,
      lastName: clean(values.lastName),
      birthDate: clean(values.birthDate),
      phoneWhatsapp: clean(values.phoneWhatsapp),
      contactEmail: clean(values.contactEmail),
      documentType: clean(values.documentType),
      documentNumber: clean(values.documentNumber),
      healthInsuranceName: clean(values.healthInsuranceName),
      healthInsuranceMemberId: clean(values.healthInsuranceMemberId),
      serviceType: values.serviceType.length > 0 ? values.serviceType : undefined,
    };

    setBusy(true);
    try {
      const { id } = await AdminApiService.createPatient(payload);
      onCreated(id);
      handleClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : tc('saveError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="patient-create-modal-backdrop"
      />

      {/* Side drawer — slides from the right */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tc('title')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-create-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">
            {tc('title')}
          </Heading>
          <div className="flex items-center gap-4">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSubmit(onSubmit)}
              isLoading={busy}
              className="w-32"
              data-testid="pc-save"
            >
              {tc('save')}
            </Button>
            <button
              type="button"
              onClick={handleClose}
              aria-label={tc('close')}
              className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          {/* Identidade */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label={tc('firstName')} htmlFor="pc-firstName" required error={errors.firstName?.message}>
              <InputWithIcon id="pc-firstName" inputSize="compact" data-testid="pc-firstName" {...register('firstName')} />
            </FormField>
            <FormField label={tc('lastName')} htmlFor="pc-lastName" optional>
              <InputWithIcon id="pc-lastName" inputSize="compact" data-testid="pc-lastName" {...register('lastName')} />
            </FormField>
            {/* Required, no preselection — drives the legal regime (Ley 25.326 vs
                LGPD) and the panel's country filter (abac-pais-fase1 5.1). */}
            {/* The message is rendered by SelectField (which also reddens the
                border); passing it to FormField too would print it twice. */}
            <FormField label={tc('country')} htmlFor="pc-country" required>
              <Controller
                control={control}
                name="country"
                render={({ field }) => (
                  <SelectField
                    id="pc-country"
                    inputSize="compact"
                    options={countryOptions}
                    placeholder={tc('countryPlaceholder')}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    error={errors.country ? tc('countryRequired') : undefined}
                    data-testid="pc-country"
                  />
                )}
              />
            </FormField>
            <FormField label={tc('birthDate')} htmlFor="pc-birthDate" optional>
              <InputWithIcon id="pc-birthDate" type="date" inputSize="compact" data-testid="pc-birthDate" {...register('birthDate')} />
            </FormField>
            <FormField label={tc('phoneWhatsapp')} htmlFor="pc-phone" optional>
              <InputWithIcon id="pc-phone" inputSize="compact" data-testid="pc-phone" {...register('phoneWhatsapp')} />
            </FormField>
            <FormField label={tc('contactEmail')} htmlFor="pc-email" optional error={errors.contactEmail?.message}>
              <InputWithIcon id="pc-email" type="email" inputSize="compact" error={errors.contactEmail?.message} data-testid="pc-email" {...register('contactEmail')} />
            </FormField>
            <FormField label={tc('documentType')} htmlFor="pc-documentType" optional>
              <Controller
                control={control}
                name="documentType"
                render={({ field }) => (
                  <SelectField
                    inputSize="compact"
                    options={documentTypeOptions}
                    placeholder={tc('unset')}
                    value={field.value}
                    onChange={field.onChange}
                    data-testid="pc-documentType"
                  />
                )}
              />
            </FormField>
            <FormField label={tc('documentNumber')} htmlFor="pc-documentNumber" optional>
              <InputWithIcon id="pc-documentNumber" inputSize="compact" data-testid="pc-documentNumber" {...register('documentNumber')} />
            </FormField>
          </div>

          {/* Cobertura médica */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
            <Text size="sm" weight="semibold" color="secondary" className="sm:col-span-2">
              {tc('coverageSection')}
            </Text>
            <FormField label={tc('healthInsuranceName')} htmlFor="pc-insName" optional>
              <InputWithIcon id="pc-insName" inputSize="compact" data-testid="pc-insName" {...register('healthInsuranceName')} />
            </FormField>
            <FormField label={tc('healthInsuranceMemberId')} htmlFor="pc-insMember" optional>
              <InputWithIcon id="pc-insMember" inputSize="compact" data-testid="pc-insMember" {...register('healthInsuranceMemberId')} />
            </FormField>
          </div>

          {/* Servicio requerido */}
          <div className="flex flex-col gap-4 pt-2 border-t border-slate-100">
            <Text size="sm" weight="semibold" color="secondary">
              {tc('serviceSection')}
            </Text>
            <FormField label={tc('serviceType')} htmlFor="pc-serviceType" optional>
              <Controller
                control={control}
                name="serviceType"
                render={({ field }) => (
                  <MultiSelect
                    options={serviceTypeOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={tc('unset')}
                    id="pc-serviceType"
                  />
                )}
              />
            </FormField>
          </div>

          {submitError && (
            <Text size="sm" className="text-red-600" data-testid="pc-error">{submitError}</Text>
          )}
        </form>
      </div>
    </>
  );
}
