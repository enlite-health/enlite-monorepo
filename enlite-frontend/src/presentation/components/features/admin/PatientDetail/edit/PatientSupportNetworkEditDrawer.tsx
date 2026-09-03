import { useEffect, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
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
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { RELATIONSHIP_CODES } from '@domain/entities/patientEnums';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';

interface Props {
  patientId: string;
  responsibles: PatientResponsibleDetail[];
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;
/** Mesmas opções do drawer geral (tipos de documento do paciente). */
const DOCUMENT_TYPES = ['DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF'] as const;
/** Procedência de um familiar criado AQUI. Existente reenvia a sua (lex C1.2). */
const PANEL_SOURCE = 'admin_manual';

// Campo opcional nasce como '' (defaultValues/append) e `source` SEMPRE vem — do
// detalhe ou de PANEL_SOURCE no append; o tipo é `string` e o submit não carrega
// fallback para um `undefined` que nunca chega.
// Spec 014 (US-D4): a mensagem é a CHAVE i18n (mesmo padrão de workerRegistrationSchemas.ts/
// LoginPage.tsx) — o zod não sabe de locale, então guarda a chave e o render traduz (`terr`
// abaixo). Sem isso o zodResolver caía no default em inglês do zod ("String must contain at
// least 1 character(s)"), visível na UI em espanhol.
const rowSchema = z.object({
  firstName: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  lastName: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  relationship: z.string().trim(),
  phone: z.string().trim(),
  email: z.union([z.literal(''), z.string().trim().email()]),
  documentType: z.string(),
  documentNumber: z.string().trim(),
  source: z.string(),
  isPrimary: z.boolean(),
});
const schema = z.object({ responsibles: z.array(rowSchema) });
type FormValues = z.infer<typeof schema>;

/**
 * Edit drawer for the `support-network` section. This section is a REPLACE:
 * PATCH /api/admin/patients/:id/support-network overwrites the whole
 * responsibles set. firstName + lastName are required per row (backend schema);
 * exactly one row can be the primary contact. displayOrder is the row index.
 *
 * REPLACE significa: o que este drawer não reenvia, o banco perde (spec 011 A1).
 * Por isso cada linha carrega e devolve TODOS os campos da tabela — documento
 * (tipo + número, lex C1.1) e procedência (`source`, lex C1.2) inclusive.
 */
export function PatientSupportNetworkEditDrawer({ patientId, responsibles, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  /** Traduz o `message` do zod, que carrega a CHAVE i18n (não o texto) — ver o comentário do schema. */
  const terr = (msg?: string): string | undefined => (msg ? t(msg) : undefined);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { register, handleSubmit, control, watch, setValue, formState: { errors, isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      responsibles: (responsibles ?? []).map((r) => ({
        firstName: r.firstName ?? '',
        lastName: r.lastName ?? '',
        relationship: r.relationship ?? '',
        phone: r.phone ?? '',
        email: r.email ?? '',
        documentType: r.documentType ?? '',
        documentNumber: r.documentNumber ?? '',
        source: r.source,
        isPrimary: r.isPrimary,
      })),
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'responsibles' });

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

  // Spec 014 (US-D4, lex D4 AUTORIZADO): isDirty do react-hook-form cobre também
  // add/remove de linha do useFieldArray, não só edição de campo.
  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
    isDirty,
    onConfirmedClose: handleClose,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  /** Enforce a single primary: selecting one clears the rest. */
  const selectPrimary = (index: number): void => {
    fields.forEach((_, i) => setValue(`responsibles.${i}.isPrimary`, i === index));
  };

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };
    const payload: PatientSupportNetworkSectionPayload = {
      responsibles: values.responsibles.map((r, index) => ({
        firstName: r.firstName.trim(),
        lastName: r.lastName.trim(),
        relationship: nz(r.relationship),
        phone: nz(r.phone),
        email: nz(r.email),
        documentType: nz(r.documentType),
        documentNumber: nz(r.documentNumber),
        source: r.source,
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
    } catch {
      // lex C1.3: a mensagem NUNCA ecoa o payload — uma resposta da API que cite
      // o número do documento não pode virar texto na tela. Genérica de propósito.
      setSubmitError(te('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const watched = watch('responsibles');

  return (
    <>
      {confirmingClose && <DiscardChangesConfirm onKeepEditing={keepEditing} onDiscard={confirmDiscard} />}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={requestClose}
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
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
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
                <FormField label={te('firstName')} htmlFor={`psn-firstName-${index}`} required error={terr(errors.responsibles?.[index]?.firstName?.message)}>
                  <InputWithIcon id={`psn-firstName-${index}`} inputSize="compact" data-testid={`psn-firstName-${index}`} {...register(`responsibles.${index}.firstName` as const)} />
                </FormField>
                <FormField label={te('lastName')} htmlFor={`psn-lastName-${index}`} required error={terr(errors.responsibles?.[index]?.lastName?.message)}>
                  <InputWithIcon id={`psn-lastName-${index}`} inputSize="compact" data-testid={`psn-lastName-${index}`} {...register(`responsibles.${index}.lastName` as const)} />
                </FormField>
                <FormField label={te('relationship')} htmlFor={`psn-rel-${index}`} optional>
                  <Controller control={control} name={`responsibles.${index}.relationship` as const} render={({ field }) => (
                    <SelectField id={`psn-rel-${index}`} inputSize="compact" options={relationshipOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`psn-rel-${index}`} />
                  )} />
                </FormField>
                <FormField label={te('phone')} htmlFor={`psn-phone-${index}`} optional>
                  <InputWithIcon id={`psn-phone-${index}`} inputSize="compact" data-testid={`psn-phone-${index}`} {...register(`responsibles.${index}.phone` as const)} />
                </FormField>
                <FormField label={te('email')} htmlFor={`psn-email-${index}`} optional error={errors.responsibles?.[index]?.email?.message}>
                  <InputWithIcon id={`psn-email-${index}`} type="email" inputSize="compact" data-testid={`psn-email-${index}`} {...register(`responsibles.${index}.email` as const)} />
                </FormField>
                <FormField label={te('documentType')} htmlFor={`psn-documentType-${index}`} optional>
                  <Controller control={control} name={`responsibles.${index}.documentType` as const} render={({ field }) => (
                    <SelectField id={`psn-documentType-${index}`} inputSize="compact" options={documentTypeOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`psn-documentType-${index}`} />
                  )} />
                </FormField>
                <FormField label={te('documentNumber')} htmlFor={`psn-documentNumber-${index}`} optional>
                  <InputWithIcon id={`psn-documentNumber-${index}`} inputSize="compact" data-testid={`psn-documentNumber-${index}`} {...register(`responsibles.${index}.documentNumber` as const)} />
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
            onClick={() => append({ firstName: '', lastName: '', relationship: '', phone: '', email: '', documentType: '', documentNumber: '', source: PANEL_SOURCE, isPrimary: fields.length === 0 })}
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
