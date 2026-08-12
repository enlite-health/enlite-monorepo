import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail, PatientClinicalSectionPayload } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const DEPENDENCY_LEVELS = ['SEVERE', 'VERY_SEVERE', 'MODERATE', 'MILD'] as const;
const CLINICAL_SPECIALTIES = [
  'INTELLECTUAL_DISABILITY', 'NEUROLOGICAL', 'MOTOR_LIMITATIONS', 'ASD', 'PSYCHIATRIC',
  'SOCIAL_VULNERABILITY', 'GERIATRIC', 'SPECIFIC_PATHOLOGY', 'CUSTOM',
] as const;
const SERVICE_TYPES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
const CLOSE_MS = 300;

// tri-state boolean flag as select: '' (unset/null) | 'true' | 'false'
const BOOL_VALUES = ['', 'true', 'false'] as const;

const schema = z.object({
  diagnosis: z.string().optional(),
  additionalComments: z.string().optional(),
  deviceType: z.string().optional(),
  dependencyLevel: z.string().optional(),
  clinicalSpecialty: z.string().optional(),
  serviceType: z.array(z.string()).optional(),
  hasJudicialProtection: z.string().optional(),
  hasCud: z.string().optional(),
  hasConsent: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

function boolToStr(v: boolean | null): string {
  return v === null || v === undefined ? '' : v ? 'true' : 'false';
}
function strToBool(v: string | undefined): boolean | null {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * Edit drawer for the `clinical` section. Saves via
 * PATCH /api/admin/patients/:id/clinical. Booleans are edited as a tri-state
 * select (—/Sí/No) so the operator can leave a flag unset (null) or clear it.
 */
export function PatientClinicalEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const td = (k: string) => t(`admin.patients.detail.${k}`);
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const tc = (k: string) => t(`admin.patients.create.${k}`);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { register, handleSubmit, control } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      diagnosis: patient.diagnosis ?? '',
      additionalComments: patient.additionalComments ?? '',
      deviceType: patient.deviceType ?? '',
      dependencyLevel: patient.dependencyLevel ?? '',
      clinicalSpecialty: patient.clinicalSpecialty ?? '',
      serviceType: patient.serviceType ?? [],
      hasJudicialProtection: boolToStr(patient.hasJudicialProtection),
      hasCud: boolToStr(patient.hasCud),
      hasConsent: boolToStr(patient.hasConsent),
    },
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => { setShow(false); setTimeout(onClose, CLOSE_MS); };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dependencyOptions: SelectOption[] = DEPENDENCY_LEVELS.map((d) => ({ value: d, label: t(`admin.patients.dependencyOptions.${d}`, { defaultValue: d }) }));
  const specialtyOptions: SelectOption[] = CLINICAL_SPECIALTIES.map((s) => ({ value: s, label: t(`admin.patients.specialtyOptions.${s}`, { defaultValue: s }) }));
  const serviceOptions: SelectOption[] = SERVICE_TYPES.map((s) => ({ value: s, label: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${s}`, { defaultValue: s }) }));
  const boolOptions: SelectOption[] = BOOL_VALUES.map((v) => ({
    value: v,
    label: v === '' ? te('unset') : v === 'true' ? t('common.yes', 'Sí') : t('common.no', 'No'),
  }));

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const payload: PatientClinicalSectionPayload = {};
    const nz = (v: string | undefined): string | null => { const s = (v ?? '').trim(); return s ? s : null; };
    if (nz(values.diagnosis) !== (patient.diagnosis ?? null)) payload.diagnosis = nz(values.diagnosis);
    if (nz(values.additionalComments) !== (patient.additionalComments ?? null)) payload.additionalComments = nz(values.additionalComments);
    if (nz(values.deviceType) !== (patient.deviceType ?? null)) payload.deviceType = nz(values.deviceType);
    if (nz(values.dependencyLevel) !== (patient.dependencyLevel ?? null)) payload.dependencyLevel = nz(values.dependencyLevel);
    if (nz(values.clinicalSpecialty) !== (patient.clinicalSpecialty ?? null)) payload.clinicalSpecialty = nz(values.clinicalSpecialty);
    const svc = values.serviceType ?? [];
    if (JSON.stringify(svc) !== JSON.stringify(patient.serviceType ?? [])) payload.serviceType = svc;
    if (strToBool(values.hasJudicialProtection) !== (patient.hasJudicialProtection ?? null)) payload.hasJudicialProtection = strToBool(values.hasJudicialProtection);
    if (strToBool(values.hasCud) !== (patient.hasCud ?? null)) payload.hasCud = strToBool(values.hasCud);
    if (strToBool(values.hasConsent) !== (patient.hasConsent ?? null)) payload.hasConsent = strToBool(values.hasConsent);

    if (Object.keys(payload).length === 0) { handleClose(); return; }

    setBusy(true);
    try {
      await AdminApiService.updatePatientSection(patient.id, 'clinical', payload);
      onSaved();
      handleClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : te('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const boolField = (name: 'hasJudicialProtection' | 'hasCud' | 'hasConsent', label: string, testid: string) => (
    <FormField label={label} htmlFor={testid} optional>
      <Controller control={control} name={name} render={({ field }) => (
        <SelectField inputSize="compact" options={boolOptions} placeholder={te('unset')} value={field.value ?? ''} onChange={field.onChange} data-testid={testid} />
      )} />
    </FormField>
  );

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="patient-clinical-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={te('clinicalTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-clinical-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{te('clinicalTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid="pce-save">
              {te('save')}
            </Button>
            <button type="button" onClick={handleClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          <FormField label={td('diagnosisCard.cid')} htmlFor="pce-diagnosis" optional>
            <InputWithIcon id="pce-diagnosis" inputSize="compact" data-testid="pce-diagnosis" {...register('diagnosis')} />
          </FormField>
          <FormField label={td('diagnosisCard.details')} htmlFor="pce-comments" optional>
            <InputWithIcon id="pce-comments" inputSize="compact" data-testid="pce-comments" {...register('additionalComments')} />
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label={t('admin.patients.dependencyLabel', { defaultValue: 'Dependencia' })} htmlFor="pce-dependency" optional>
              <Controller control={control} name="dependencyLevel" render={({ field }) => (
                <SelectField inputSize="compact" options={dependencyOptions} placeholder={te('unset')} value={field.value ?? ''} onChange={field.onChange} data-testid="pce-dependency" />
              )} />
            </FormField>
            <FormField label={t('admin.patients.specialtyLabel', { defaultValue: 'Especialidad' })} htmlFor="pce-specialty" optional>
              <Controller control={control} name="clinicalSpecialty" render={({ field }) => (
                <SelectField inputSize="compact" options={specialtyOptions} placeholder={te('unset')} value={field.value ?? ''} onChange={field.onChange} data-testid="pce-specialty" />
              )} />
            </FormField>
            <FormField label={te('deviceType')} htmlFor="pce-device" optional>
              <InputWithIcon id="pce-device" inputSize="compact" data-testid="pce-device" {...register('deviceType')} />
            </FormField>
            <FormField label={tc('serviceType')} htmlFor="pce-serviceType" optional>
              <Controller control={control} name="serviceType" render={({ field }) => (
                <MultiSelect options={serviceOptions} value={field.value ?? []} onChange={field.onChange} placeholder={te('unset')} id="pce-serviceType" />
              )} />
            </FormField>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
            {boolField('hasJudicialProtection', td('diagnosisCard.protectionCertificate'), 'pce-hasJudicialProtection')}
            {boolField('hasCud', td('diagnosisCard.disabilityCertificate'), 'pce-hasCud')}
            {boolField('hasConsent', te('hasConsent'), 'pce-hasConsent')}
          </div>

          {submitError && <Text size="sm" className="text-red-600" data-testid="pce-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
