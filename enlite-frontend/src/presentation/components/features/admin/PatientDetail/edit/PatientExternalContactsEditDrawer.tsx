import { useEffect, useRef, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2 } from 'lucide-react';
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import type { PatientExternalContactDetail } from '@domain/entities/PatientDetail';
import { EXTERNAL_CONTACT_RELATION_CODES } from '@domain/entities/patientEnums';
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
  externalContacts: PatientExternalContactDetail[];
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

// `id` OCULTO: vazio = linha nova (POST); preenchido = linha existente (PATCH por linha, ADR-1).
const rowSchema = z.object({
  id: z.string(),
  relation: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  name: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  phone: z.string().trim(),
});
const schema = z.object({ externalContacts: z.array(rowSchema) });
type FormValues = z.infer<typeof schema>;

/**
 * Edit drawer dos contatos externos SEM vínculo familiar — rede de apoio (spec 018, PR-2, US-12,
 * `lex` #4; `contracts/support-network.md`). Escrita POR LINHA (ADR-1), mesmo molde de
 * `PatientSupportNetworkEditDrawer`: cada linha nasce (POST), muda (PATCH) ou desaparece (POST
 * .../deactivate, NUNCA DELETE — REGRA-08/D94, troca = desativar + criar).
 */
export function PatientExternalContactsEditDrawer({ patientId, externalContacts, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const terr = (msg?: string): string | undefined => (msg ? t(msg) : undefined);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const toDeactivateRef = useRef<string[]>([]);

  const { register, handleSubmit, control, watch, formState: { errors, isDirty }, setValue } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      externalContacts: (externalContacts ?? []).map((c) => ({
        id: c.id,
        relation: c.relation,
        name: c.name,
        phone: c.phone ?? '',
      })),
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'externalContacts' });

  const relationOptions: SelectOption[] = EXTERNAL_CONTACT_RELATION_CODES.map((r) => ({
    value: r,
    label: t(`admin.patients.detail.externalContactRelationOptions.${r}`, { defaultValue: r }),
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

  /**
   * Remover: linha NOVA (sem id) some sem chamar a API; linha EXISTENTE é desativada no submit.
   * ⚠️ `fields[index].id` é a CHAVE INTERNA do `useFieldArray` (RHF gera uma sempre, mesmo em
   * linha nova) — usar `watch` para ler o `id` do MODELO (vazio = nova), como
   * `PatientSupportNetworkEditDrawer` já fazia.
   */
  const removeRow = (index: number): void => {
    const id = watch(`externalContacts.${index}.id`);
    if (id) toDeactivateRef.current.push(id);
    remove(index);
  };

  const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    setBusy(true);
    try {
      // 1. Desativar as removidas PRIMEIRO (mesma ordem do drawer de responsáveis).
      while (toDeactivateRef.current.length > 0) {
        const id = toDeactivateRef.current[0];
        await AdminPatientContactRowsApiService.deactivateExternalContact(patientId, id);
        toDeactivateRef.current = toDeactivateRef.current.slice(1);
      }
      // 2. Cria/atualiza cada linha; o id REAL volta pro form (achado 018/PR-1 — evita duplicar
      //    em retry após falha de outra linha).
      for (let i = 0; i < values.externalContacts.length; i += 1) {
        const r = values.externalContacts[i];
        const payload = { relation: r.relation, name: r.name.trim(), phone: nz(r.phone) };
        if (r.id) {
          await AdminPatientContactRowsApiService.updateExternalContact(patientId, r.id, payload);
        } else {
          const created = await AdminPatientContactRowsApiService.createExternalContact(patientId, {
            relation: payload.relation,
            name: payload.name,
            phone: payload.phone,
          });
          setValue(`externalContacts.${i}.id`, created.id);
        }
      }
      onSaved();
      handleClose();
    } catch {
      onSaved();
      // lex C1.3: a mensagem NUNCA ecoa o payload (nome/telefone do terceiro).
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
        data-testid="patient-external-contacts-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={te('externalContactsTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-external-contacts-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{te('externalContactsTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid="pxc-save">
              {te('save')}
            </Button>
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          {/* lex C10 (dever de informar, Ley 25.326 art. 6): o terceiro sem vínculo familiar
              tem o mesmo aviso dos responsáveis — o contato fica registrado e pode ser impresso. */}
          <Text size="xs" color="muted" data-testid="pxc-notice">{te('externalContactsNotice')}</Text>

          {fields.length === 0 && (
            <Text size="sm" color="muted" data-testid="pxc-empty">{t('admin.patients.detail.noData')}</Text>
          )}

          {fields.map((f, index) => (
            <div key={f.id} data-testid={`pxc-row-${index}`} data-clarity-mask="True" className="flex flex-col gap-3 p-4 rounded-xl border border-slate-200">
              <div className="flex items-center justify-between">
                <Text size="sm" weight="semibold" color="secondary">{te('externalContact')} {index + 1}</Text>
                <button type="button" onClick={() => removeRow(index)} aria-label={te('removeExternalContact')} data-testid={`pxc-remove-${index}`} className="text-red-400 hover:text-red-600 transition-colors p-1 rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label={te('relation')} htmlFor={`pxc-relation-${index}`} required>
                  <Controller control={control} name={`externalContacts.${index}.relation` as const} render={({ field }) => (
                    <SelectField id={`pxc-relation-${index}`} inputSize="compact" options={relationOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`pxc-relation-${index}`} />
                  )} />
                </FormField>
                <FormField label={te('name')} htmlFor={`pxc-name-${index}`} required error={terr(errors.externalContacts?.[index]?.name?.message)}>
                  <InputWithIcon id={`pxc-name-${index}`} inputSize="compact" data-testid={`pxc-name-${index}`} {...register(`externalContacts.${index}.name` as const)} />
                </FormField>
                <FormField label={te('phone')} htmlFor={`pxc-phone-${index}`} optional>
                  <InputWithIcon id={`pxc-phone-${index}`} inputSize="compact" data-testid={`pxc-phone-${index}`} {...register(`externalContacts.${index}.phone` as const)} />
                </FormField>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ id: '', relation: '', name: '', phone: '' })}
            className="flex items-center gap-1 w-fit"
            data-testid="pxc-add"
          >
            <Plus className="w-4 h-4" />
            {te('addExternalContact')}
          </Button>

          {submitError && <Text size="sm" className="text-red-600" data-testid="pxc-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
