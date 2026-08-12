import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail, PatientGeneralSectionPayload } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const DOCUMENT_TYPES = ['DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF'] as const;
const SEXES = ['FEMALE', 'MALE', 'INTERSEX', 'UNDISCLOSED'] as const;
const CLOSE_MS = 300;

const schema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().optional(),
  phoneWhatsapp: z.string().trim().optional(),
  contactEmail: z.union([z.literal(''), z.string().trim().email()]).optional(),
  documentType: z.string().optional(),
  documentNumber: z.string().trim().optional(),
  birthDate: z.string().optional(),
  sex: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

/** yyyy-MM-dd for <input type="date"> (patient.birthDate is an ISO string). */
function toDateInput(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/**
 * Edit drawer for the `general` section — same side-drawer pattern as
 * PatientCreateModal. Saves via PATCH /api/admin/patients/:id/general
 * (whitelist enforced by the backend). Only changed fields are sent; a cleared
 * nullable field is sent as null.
 */
export function PatientGeneralEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.create.${k}`);
  const td = (k: string) => t(`admin.patients.detail.${k}`);
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { register, handleSubmit, control, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: patient.firstName ?? '',
      lastName: patient.lastName ?? '',
      phoneWhatsapp: patient.phoneWhatsapp ?? '',
      contactEmail: '',
      documentType: patient.documentType ?? '',
      documentNumber: patient.documentNumber ?? '',
      birthDate: toDateInput(patient.birthDate),
      sex: patient.sex ?? '',
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
  const sexOptions: SelectOption[] = SEXES.map((s) => ({
    value: s,
    label: t(`admin.patients.detail.sex.${s}`, { defaultValue: s }),
  }));

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const payload: PatientGeneralSectionPayload = {};
    // nullable text: '' clears to null; only send when changed.
    const nz = (v: string | undefined): string | null => {
      const s = (v ?? '').trim();
      return s ? s : null;
    };
    if (values.firstName.trim() !== (patient.firstName ?? '')) payload.firstName = values.firstName.trim();
    if (nz(values.lastName) !== (patient.lastName ?? null)) payload.lastName = nz(values.lastName);
    if (nz(values.phoneWhatsapp) !== (patient.phoneWhatsapp ?? null)) payload.phoneWhatsapp = nz(values.phoneWhatsapp);
    if (nz(values.contactEmail)) payload.contactEmail = nz(values.contactEmail);
    if (nz(values.documentType) !== (patient.documentType ?? null)) payload.documentType = nz(values.documentType);
    if (nz(values.documentNumber) !== (patient.documentNumber ?? null)) payload.documentNumber = nz(values.documentNumber);
    if (nz(values.sex) !== (patient.sex ?? null)) payload.sex = nz(values.sex);
    const birth = (values.birthDate ?? '').trim() || null;
    if (birth !== toDateInput(patient.birthDate) ) payload.birthDate = birth;

    if (Object.keys(payload).length === 0) { handleClose(); return; }

    setBusy(true);
    try {
      await AdminApiService.updatePatientSection(patient.id, 'general', payload);
      onSaved();
      handleClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : te('saveError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="patient-general-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={te('generalTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-general-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{te('generalTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid="pge-save">
              {te('save')}
            </Button>
            <button type="button" onClick={handleClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label={tc('firstName')} htmlFor="pge-firstName" required error={errors.firstName?.message}>
              <InputWithIcon id="pge-firstName" inputSize="compact" data-testid="pge-firstName" {...register('firstName')} />
            </FormField>
            <FormField label={tc('lastName')} htmlFor="pge-lastName" optional>
              <InputWithIcon id="pge-lastName" inputSize="compact" data-testid="pge-lastName" {...register('lastName')} />
            </FormField>
            <FormField label={tc('phoneWhatsapp')} htmlFor="pge-phone" optional>
              <InputWithIcon id="pge-phone" inputSize="compact" data-testid="pge-phone" {...register('phoneWhatsapp')} />
            </FormField>
            <FormField label={tc('contactEmail')} htmlFor="pge-email" optional error={errors.contactEmail?.message}>
              <InputWithIcon id="pge-email" type="email" inputSize="compact" error={errors.contactEmail?.message} data-testid="pge-email" {...register('contactEmail')} />
            </FormField>
            <FormField label={tc('documentType')} htmlFor="pge-documentType" optional>
              <Controller control={control} name="documentType" render={({ field }) => (
                <SelectField inputSize="compact" options={documentTypeOptions} placeholder={te('unset')} value={field.value ?? ''} onChange={field.onChange} data-testid="pge-documentType" />
              )} />
            </FormField>
            <FormField label={tc('documentNumber')} htmlFor="pge-documentNumber" optional>
              <InputWithIcon id="pge-documentNumber" inputSize="compact" data-testid="pge-documentNumber" {...register('documentNumber')} />
            </FormField>
            <FormField label={td('generalInfoCard.birthDate')} htmlFor="pge-birthDate" optional>
              <InputWithIcon id="pge-birthDate" type="date" inputSize="compact" data-testid="pge-birthDate" {...register('birthDate')} />
            </FormField>
            <FormField label={td('generalInfoCard.sex')} htmlFor="pge-sex" optional>
              <Controller control={control} name="sex" render={({ field }) => (
                <SelectField inputSize="compact" options={sexOptions} placeholder={te('unset')} value={field.value ?? ''} onChange={field.onChange} data-testid="pge-sex" />
              )} />
            </FormField>
          </div>

          {submitError && <Text size="sm" className="text-red-600" data-testid="pge-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
