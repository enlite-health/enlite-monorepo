import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail, PatientServiceSectionPayload } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { SelectOption } from '@presentation/components/molecules/SelectField';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const SERVICE_TYPES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
const CLOSE_MS = 300;

const schema = z.object({ serviceType: z.array(z.string()) });
type FormValues = z.infer<typeof schema>;

/**
 * Edit drawer for the `service` section — targeted service_type update
 * (PATCH /api/admin/patients/:id/service). Never clobbers the clinical block.
 */
export function PatientServiceEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const tc = (k: string) => t(`admin.patients.create.${k}`);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { handleSubmit, control, formState: { isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { serviceType: patient.serviceType ?? [] },
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => { setShow(false); setTimeout(onClose, CLOSE_MS); };

  // Spec 014 (US-D4, lex D4 AUTORIZADO).
  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
    isDirty,
    onConfirmedClose: handleClose,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const serviceOptions: SelectOption[] = SERVICE_TYPES.map((s) => ({
    value: s,
    label: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${s}`, { defaultValue: s }),
  }));

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const payload: PatientServiceSectionPayload = { serviceType: values.serviceType };
    setBusy(true);
    try {
      await AdminApiService.updatePatientSection(patient.id, 'service', payload);
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
      {confirmingClose && <DiscardChangesConfirm onKeepEditing={keepEditing} onDiscard={confirmDiscard} />}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={requestClose}
        data-testid="patient-service-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={te('serviceTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-service-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{te('serviceTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid="psv-save">
              {te('save')}
            </Button>
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          <FormField label={tc('serviceType')} htmlFor="psv-serviceType" optional>
            {/* `field.value` nunca é undefined: `defaultValues.serviceType` (linha acima) já
                garante array — um `?? []` aqui seria morto (0% de branch, D200). */}
            <Controller control={control} name="serviceType" render={({ field }) => (
              <MultiSelect options={serviceOptions} value={field.value} onChange={field.onChange} placeholder={te('selectPlaceholder')} id="psv-serviceType" />
            )} />
          </FormField>

          {submitError && <Text size="sm" className="text-red-600" data-testid="psv-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
