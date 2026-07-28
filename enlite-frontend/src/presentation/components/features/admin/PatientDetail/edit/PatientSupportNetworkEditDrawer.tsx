import { useEffect, useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2 } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type {
  PatientResponsibleDetail,
  PatientSupportNetworkSectionPayload,
} from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';

interface Props {
  patientId: string;
  responsibles: PatientResponsibleDetail[];
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

const rowSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  relationship: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.union([z.literal(''), z.string().trim().email()]).optional(),
  isPrimary: z.boolean(),
});
const schema = z.object({ responsibles: z.array(rowSchema) });
type FormValues = z.infer<typeof schema>;

/**
 * Edit drawer for the `support-network` section. This section is a REPLACE:
 * PATCH /api/admin/patients/:id/support-network overwrites the whole
 * responsibles set. firstName + lastName are required per row (backend schema);
 * exactly one row can be the primary contact. displayOrder is the row index.
 */
export function PatientSupportNetworkEditDrawer({ patientId, responsibles, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { register, handleSubmit, control, watch, setValue, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      responsibles: (responsibles ?? []).map((r) => ({
        firstName: r.firstName ?? '',
        lastName: r.lastName ?? '',
        relationship: r.relationship ?? '',
        phone: r.phone ?? '',
        email: r.email ?? '',
        isPrimary: r.isPrimary,
      })),
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'responsibles' });

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

  /** Enforce a single primary: selecting one clears the rest. */
  const selectPrimary = (index: number): void => {
    fields.forEach((_, i) => setValue(`responsibles.${i}.isPrimary`, i === index));
  };

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const nz = (v: string | undefined): string | null => { const s = (v ?? '').trim(); return s ? s : null; };
    const payload: PatientSupportNetworkSectionPayload = {
      responsibles: values.responsibles.map((r, index) => ({
        firstName: r.firstName.trim(),
        lastName: r.lastName.trim(),
        relationship: nz(r.relationship),
        phone: nz(r.phone),
        email: nz(r.email),
        isPrimary: r.isPrimary,
        displayOrder: index,
      })),
    };
    // If nobody is primary but there is at least one row, make the first primary.
    if (payload.responsibles.length > 0 && !payload.responsibles.some((r) => r.isPrimary)) {
      payload.responsibles[0].isPrimary = true;
    }

    setBusy(true);
    try {
      await AdminApiService.updatePatientSection(patientId, 'support-network', payload);
      onSaved();
      handleClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : te('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const watched = watch('responsibles');

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="patient-support-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={te('supportTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-support-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{te('supportTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid="psn-save">
              {te('save')}
            </Button>
            <button type="button" onClick={handleClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          {fields.length === 0 && (
            <Text size="sm" color="muted" data-testid="psn-empty">{t('admin.patients.detail.noData')}</Text>
          )}

          {fields.map((f, index) => (
            <div key={f.id} data-testid={`psn-row-${index}`} className="flex flex-col gap-3 p-4 rounded-xl border border-slate-200">
              <div className="flex items-center justify-between">
                <Text size="sm" weight="semibold" color="secondary">{te('responsible')} {index + 1}</Text>
                <button type="button" onClick={() => remove(index)} aria-label={te('removeResponsible')} data-testid={`psn-remove-${index}`} className="text-red-400 hover:text-red-600 transition-colors p-1 rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label={te('firstName')} htmlFor={`psn-firstName-${index}`} required error={errors.responsibles?.[index]?.firstName?.message}>
                  <InputWithIcon id={`psn-firstName-${index}`} inputSize="compact" data-testid={`psn-firstName-${index}`} {...register(`responsibles.${index}.firstName` as const)} />
                </FormField>
                <FormField label={te('lastName')} htmlFor={`psn-lastName-${index}`} required error={errors.responsibles?.[index]?.lastName?.message}>
                  <InputWithIcon id={`psn-lastName-${index}`} inputSize="compact" data-testid={`psn-lastName-${index}`} {...register(`responsibles.${index}.lastName` as const)} />
                </FormField>
                <FormField label={te('relationship')} htmlFor={`psn-rel-${index}`} optional>
                  <InputWithIcon id={`psn-rel-${index}`} inputSize="compact" data-testid={`psn-rel-${index}`} {...register(`responsibles.${index}.relationship` as const)} />
                </FormField>
                <FormField label={te('phone')} htmlFor={`psn-phone-${index}`} optional>
                  <InputWithIcon id={`psn-phone-${index}`} inputSize="compact" data-testid={`psn-phone-${index}`} {...register(`responsibles.${index}.phone` as const)} />
                </FormField>
                <FormField label={te('email')} htmlFor={`psn-email-${index}`} optional error={errors.responsibles?.[index]?.email?.message}>
                  <InputWithIcon id={`psn-email-${index}`} type="email" inputSize="compact" data-testid={`psn-email-${index}`} {...register(`responsibles.${index}.email` as const)} />
                </FormField>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="psn-primary"
                  checked={!!watched?.[index]?.isPrimary}
                  onChange={() => selectPrimary(index)}
                  data-testid={`psn-primary-${index}`}
                  className="accent-primary w-4 h-4"
                />
                <Text as="span" size="sm" color="secondary">{te('isPrimary')}</Text>
              </label>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ firstName: '', lastName: '', relationship: '', phone: '', email: '', isPrimary: fields.length === 0 })}
            className="flex items-center gap-1 w-fit"
            data-testid="psn-add"
          >
            <Plus className="w-4 h-4" />
            {te('addResponsible')}
          </Button>

          {submitError && <Text size="sm" className="text-red-600" data-testid="psn-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
