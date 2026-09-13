/**
 * PatientProfessionalEditDrawer — cria ou edita UMA linha da equipe tratante (spec 018, PR-5,
 * US-11; `contracts/care-team.md`). Molde simplificado de `PatientSupportNetworkEditDrawer`
 * (mesma escrita por LINHA, spec 018 PR-1 ADR-1), mas de UM registro por vez — o "lápis" abre
 * este drawer já preenchido (`professional` presente → PATCH), o "Nuevo" abre vazio (POST).
 *
 * lex C13 (dever de informar, Ley 25.326 art. 6): o aviso abaixo do título diz, em es-AR, que o
 * contato do profissional (terceiro) fica registrado e sai impresso no documento entregue à
 * família/financiador — mesmo texto/chave do aviso já usado no drawer de cobertura (C10 do PR-1).
 */
import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import type { PatientProfessionalDetail } from '@domain/entities/PatientDetail';
import { PATIENT_PROFESSIONAL_SPECIALTY_CODES } from '@domain/entities/patientEnums';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';

interface Props {
  patientId: string;
  /** Presente = editar (PATCH); ausente = criar (POST). */
  professional: PatientProfessionalDetail | null;
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

// Mensagem = CHAVE i18n (o zod não conhece locale — mesmo padrão de PatientSupportNetworkEditDrawer).
const schema = z.object({
  name: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  phone: z.string().trim(),
  email: z.union([z.literal(''), z.string().trim().email()]),
  specialty: z.string().trim(),
});
type FormValues = z.infer<typeof schema>;

export function PatientProfessionalEditDrawer({ patientId, professional, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const tc = (k: string) => t(`admin.patients.detail.treatingTeamCard.${k}`);
  const terr = (msg?: string): string | undefined => (msg ? t(msg) : undefined);

  const isEditing = professional !== null;
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { register, handleSubmit, control, formState: { errors, isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: professional?.name ?? '',
      phone: professional?.phone ?? '',
      email: professional?.email ?? '',
      specialty: professional?.specialty ?? '',
    },
  });

  const specialtyOptions: SelectOption[] = PATIENT_PROFESSIONAL_SPECIALTY_CODES.map((s) => ({
    value: s,
    label: t(`admin.patients.detail.treatingTeamCard.specialtyOptions.${s}`, { defaultValue: s }),
  }));

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => { setShow(false); setTimeout(onClose, CLOSE_MS); };

  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
    isDirty,
    onConfirmedClose: handleClose,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    setBusy(true);
    const payload = {
      name: values.name.trim(),
      phone: nz(values.phone),
      email: nz(values.email),
      specialty: (nz(values.specialty) as PatientProfessionalDetail['specialty']) ?? null,
    };
    try {
      if (isEditing) {
        await AdminPatientContactRowsApiService.updateProfessional(patientId, professional.id, payload);
      } else {
        await AdminPatientContactRowsApiService.createProfessional(patientId, payload);
      }
      onSaved();
      handleClose();
    } catch {
      // lex C1.3: a mensagem NUNCA ecoa o payload (mesma régua de PatientSupportNetworkEditDrawer).
      setSubmitError(te('saveError'));
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
        data-testid="professional-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tc(isEditing ? 'editTitle' : 'newTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="professional-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{tc(isEditing ? 'editTitle' : 'newTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid="professional-save">
              {te('save')}
            </Button>
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          {/* lex C13 — dever de informar no ponto da coleta (mesma régua do C10 da cobertura). */}
          <Text size="xs" color="muted" data-testid="professional-notice">{tc('notice')}</Text>

          {/* lex C2.1/C6: nome/telefone/e-mail/especialidade de terceiro é dado clínico do paciente
              — o Clarity (Balanced) não mascara texto por si só (molde PatientAddressDrawer.tsx,
              CoverageEmergencyContactsEditor.tsx). */}
          <div data-clarity-mask="True" className="flex flex-col gap-5">
          <FormField label={tc('tableFullName')} htmlFor="professional-name" required error={terr(errors.name?.message)}>
            <InputWithIcon id="professional-name" inputSize="compact" data-testid="professional-name" {...register('name')} />
          </FormField>
          <FormField label={tc('tablePhoneNumber')} htmlFor="professional-phone" optional>
            <InputWithIcon id="professional-phone" inputSize="compact" data-testid="professional-phone" {...register('phone')} />
          </FormField>
          <FormField label={te('email')} htmlFor="professional-email" optional error={errors.email?.message}>
            <InputWithIcon id="professional-email" type="email" inputSize="compact" data-testid="professional-email" {...register('email')} />
          </FormField>
          <FormField label={tc('tableSpecialty')} htmlFor="professional-specialty" optional>
            <Controller control={control} name="specialty" render={({ field }) => (
              <SelectField id="professional-specialty" inputSize="compact" options={specialtyOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid="professional-specialty" />
            )} />
          </FormField>
          </div>

          {submitError && <Text size="sm" className="text-red-600" data-testid="professional-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
