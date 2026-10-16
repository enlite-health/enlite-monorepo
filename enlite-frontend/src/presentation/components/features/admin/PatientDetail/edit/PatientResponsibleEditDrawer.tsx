/**
 * PatientResponsibleEditDrawer — cria ou edita UM familiar (responsável) da rede de apoio
 * (molde: `PatientProfessionalEditDrawer`). O "lápis" abre este drawer já preenchido
 * (`responsible` presente → PATCH), o "Nuevo" abre vazio (POST); remover é outra ação, com
 * confirmação própria (`DeactivateResponsibleConfirm`). Substitui o antigo drawer da lista
 * inteira (`PatientSupportNetworkEditDrawer`): campos, validações e payload por linha são os mesmos.
 *
 * TITULAR (no máximo UM ativo por paciente — índice único parcial `idx_patient_responsibles_one_primary`,
 * migration 420; o backend NÃO despromove sozinho: POST/PATCH com `isPrimary` com outro titular
 * ativo responde 409 `PRIMARY_ALREADY_SET`). Por isso, igual ao drawer antigo:
 *  - marcar este como titular com OUTRO titular ativo → despromove o outro PRIMEIRO, grava este depois;
 *  - sem outro titular ativo, este É o titular (o drawer antigo promovia a 1ª linha quando ninguém
 *    estava marcado): a caixa aparece marcada e travada — mudar de titular é marcando OUTRO familiar.
 */
import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import type { PatientResponsibleDetail } from '@domain/entities/PatientDetail';
import { RELATIONSHIP_CODES } from '@domain/entities/patientEnums';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';

interface Props {
  patientId: string;
  /** Presente = editar (PATCH); ausente = criar (POST). */
  responsible: PatientResponsibleDetail | null;
  /** Todos os familiares ativos do paciente — para saber se já existe OUTRO titular. */
  responsibles: PatientResponsibleDetail[];
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;
/** Mesmas opções do drawer geral (tipos de documento do paciente). */
const DOCUMENT_TYPES = ['DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF'] as const;

// Mensagem = CHAVE i18n (o zod não conhece locale — Spec 014 US-D4: sem isso o zodResolver caía no
// default em inglês do zod, visível na UI em espanhol). O render traduz (`terr`).
const schema = z.object({
  firstName: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  lastName: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  relationship: z.string().trim(),
  phone: z.string().trim(),
  email: z.union([z.literal(''), z.string().trim().email()]),
  documentType: z.string(),
  documentNumber: z.string().trim(),
  isPrimary: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export function PatientResponsibleEditDrawer({ patientId, responsible, responsibles, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const tc = (k: string) => t(`admin.patients.detail.familyCard.${k}`);
  const terr = (msg?: string): string | undefined => (msg ? t(msg) : undefined);

  const isEditing = responsible !== null;
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Despromover o titular atual é um PATCH em OUTRA linha → exige `patient_family:update`.
  const { allowed: canUpdateRow } = useActionGate('patient_family', 'update');

  const otherPrimary = (responsibles ?? []).find((r) => r.isPrimary && r.id !== responsible?.id) ?? null;

  const { register, handleSubmit, control, watch, formState: { errors, isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      firstName: responsible?.firstName ?? '',
      lastName: responsible?.lastName ?? '',
      relationship: responsible?.relationship ?? '',
      phone: responsible?.phone ?? '',
      email: responsible?.email ?? '',
      documentType: responsible?.documentType ?? '',
      documentNumber: responsible?.documentNumber ?? '',
      isPrimary: responsible?.isPrimary ?? false,
    },
  });

  const documentTypeOptions: SelectOption[] = DOCUMENT_TYPES.map((d) => ({
    value: d,
    label: t(`admin.patients.detail.documentTypes.${d}`, { defaultValue: d }),
  }));
  // Spec 012 US-B5: os 9 códigos da migration 139 (CHECK) — texto livre dava 23514.
  const relationshipOptions: SelectOption[] = RELATIONSHIP_CODES.map((r) => ({
    value: r,
    label: t(`admin.patients.detail.relationshipOptions.${r}`, { defaultValue: r }),
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

  // Sem outro titular ativo, este é o titular (criar o 1º familiar; "desmarcar" o único titular).
  const primaryLocked = otherPrimary === null || !canUpdateRow;
  const isPrimaryChecked = otherPrimary === null ? true : watch('isPrimary');

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    setBusy(true);
    const isPrimary = otherPrimary === null ? true : values.isPrimary;
    const payload = {
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      relationship: nz(values.relationship),
      phone: nz(values.phone),
      email: nz(values.email),
      documentType: nz(values.documentType),
      documentNumber: nz(values.documentNumber),
      isPrimary,
    };
    let demoted = false;
    try {
      // O titular anterior sai PRIMEIRO — libera o índice de titular único antes de promover este.
      if (isPrimary && otherPrimary) {
        await AdminPatientContactRowsApiService.updateResponsible(patientId, otherPrimary.id, { isPrimary: false });
        demoted = true;
      }
      if (isEditing) {
        await AdminPatientContactRowsApiService.updateResponsible(patientId, responsible.id, payload);
      } else {
        await AdminPatientContactRowsApiService.createResponsible(patientId, payload);
      }
      onSaved();
      handleClose();
    } catch {
      // Se o titular antigo já foi despromovido, a lista no servidor mudou: relê para a tela não mentir.
      if (demoted) onSaved();
      // lex C1.3: a mensagem NUNCA ecoa o payload — uma resposta da API que cite o número do
      // documento não pode virar texto na tela. Genérica de propósito.
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
        data-testid="responsible-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tc(isEditing ? 'editTitle' : 'newTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="responsible-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{tc(isEditing ? 'editTitle' : 'newTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid="responsible-save">
              {te('save')}
            </Button>
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label={te('firstName')} htmlFor="responsible-firstName" required error={terr(errors.firstName?.message)}>
              <InputWithIcon id="responsible-firstName" inputSize="compact" data-testid="responsible-firstName" {...register('firstName')} />
            </FormField>
            <FormField label={te('lastName')} htmlFor="responsible-lastName" required error={terr(errors.lastName?.message)}>
              <InputWithIcon id="responsible-lastName" inputSize="compact" data-testid="responsible-lastName" {...register('lastName')} />
            </FormField>
            <FormField label={te('relationship')} htmlFor="responsible-rel" optional>
              <Controller control={control} name="relationship" render={({ field }) => (
                <SelectField id="responsible-rel" inputSize="compact" options={relationshipOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid="responsible-rel" />
              )} />
            </FormField>
            <FormField label={te('phone')} htmlFor="responsible-phone" optional>
              <InputWithIcon id="responsible-phone" inputSize="compact" data-testid="responsible-phone" {...register('phone')} />
            </FormField>
            <FormField label={te('email')} htmlFor="responsible-email" optional error={errors.email?.message}>
              <InputWithIcon id="responsible-email" type="email" inputSize="compact" data-testid="responsible-email" {...register('email')} />
            </FormField>
            <FormField label={te('documentType')} htmlFor="responsible-documentType" optional>
              <Controller control={control} name="documentType" render={({ field }) => (
                <SelectField id="responsible-documentType" inputSize="compact" options={documentTypeOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid="responsible-documentType" />
              )} />
            </FormField>
            <FormField label={te('documentNumber')} htmlFor="responsible-documentNumber" optional>
              <InputWithIcon id="responsible-documentNumber" inputSize="compact" data-testid="responsible-documentNumber" {...register('documentNumber')} />
            </FormField>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              {...register('isPrimary')}
              checked={isPrimaryChecked}
              disabled={primaryLocked}
              data-testid="responsible-primary"
              className="accent-primary w-4 h-4"
            />
            <Text as="span" size="sm" color="secondary">{te('isPrimary')}</Text>
          </label>

          {submitError && <Text size="sm" className="text-red-600" data-testid="responsible-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
