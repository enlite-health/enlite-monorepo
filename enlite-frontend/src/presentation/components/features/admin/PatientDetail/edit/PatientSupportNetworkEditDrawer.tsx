import { useEffect, useRef, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2 } from 'lucide-react';
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import type { PatientResponsibleDetail } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { RELATIONSHIP_CODES } from '@domain/entities/patientEnums';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
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

// Campo opcional nasce como '' (defaultValues/append); o tipo é `string` e o submit não carrega
// fallback para um `undefined` que nunca chega. `id` é OCULTO (não registrado como input visível):
// vazio = linha nova (POST); preenchido = linha existente (PATCH por linha, spec 018 PR-1).
// Spec 014 (US-D4): a mensagem é a CHAVE i18n (mesmo padrão de workerRegistrationSchemas.ts/
// LoginPage.tsx) — o zod não sabe de locale, então guarda a chave e o render traduz (`terr`
// abaixo). Sem isso o zodResolver caía no default em inglês do zod ("String must contain at
// least 1 character(s)"), visível na UI em espanhol.
const rowSchema = z.object({
  id: z.string(),
  firstName: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  lastName: z.string().trim().min(1, 'admin.patients.editDrawer.requiredField'),
  relationship: z.string().trim(),
  phone: z.string().trim(),
  email: z.union([z.literal(''), z.string().trim().email()]),
  documentType: z.string(),
  documentNumber: z.string().trim(),
  isPrimary: z.boolean(),
});
const schema = z.object({ responsibles: z.array(rowSchema) });
type FormValues = z.infer<typeof schema>;

/**
 * Edit drawer for the responsáveis da rede de apoio — escrita POR LINHA (spec 018, PR-1, ADR-1;
 * SUP-37). `PATCH /patients/:id/support-network` (a lista inteira) virou 410: cada linha do
 * formulário nasce (`POST .../responsibles`), muda (`PATCH .../responsibles/:rid`) ou desaparece
 * (`POST .../responsibles/:rid/deactivate`, nunca DELETE) por conta própria — editar uma NÃO toca
 * no id das outras. `firstName`/`lastName` são obrigatórios por linha (zod); só um pode ser o
 * contato titular.
 */
export function PatientSupportNetworkEditDrawer({ patientId, responsibles, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  /** Traduz o `message` do zod, que carrega a CHAVE i18n (não o texto) — ver o comentário do schema. */
  const terr = (msg?: string): string | undefined => (msg ? t(msg) : undefined);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Ids de linhas EXISTENTES removidas nesta sessão do drawer — desativadas no submit. */
  const toDeactivateRef = useRef<string[]>([]);
  // Conserto rodada B (Gabriel 15/09): o botão "Nuevo" do card abre para quem tem `create` OU
  // `update` — dentro do drawer, adicionar linha exige `create` e editar linha EXISTENTE exige
  // `update`. Quem tem as duas mantém o comportamento de sempre.
  const { allowed: canCreateRow } = useActionGate('patient_family', 'create');
  const { allowed: canUpdateRow } = useActionGate('patient_family', 'update');

  const { register, handleSubmit, control, watch, setValue, formState: { errors, isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      responsibles: (responsibles ?? []).map((r) => ({
        id: r.id,
        firstName: r.firstName ?? '',
        lastName: r.lastName ?? '',
        relationship: r.relationship ?? '',
        phone: r.phone ?? '',
        email: r.email ?? '',
        documentType: r.documentType ?? '',
        documentNumber: r.documentNumber ?? '',
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

  /** Remover: linha NOVA (sem id) some sem chamar a API; linha EXISTENTE é desativada no submit. */
  const removeRow = (index: number): void => {
    const id = watch(`responsibles.${index}.id`);
    if (id) toDeactivateRef.current.push(id);
    remove(index);
  };

  const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    let rows = values.responsibles;
    // If nobody is primary but there is at least one row, make the first primary.
    if (rows.length > 0 && !rows.some((r) => r.isPrimary)) {
      rows = rows.map((r, i) => (i === 0 ? { ...r, isPrimary: true } : r));
    }

    setBusy(true);
    try {
      // 1. Desativar as removidas PRIMEIRO — libera o índice de titular único antes de
      //    promover outra linha (a mesma ordem vale para o passo 2/3 abaixo).
      // CR-1 (achado do gate revisao-pr): cada id sai do ref assim que a SUA chamada tem
      // sucesso — não só depois do laço inteiro. Sem isto, se a 2ª de 3 desativações falhasse,
      // a 1ª (já desativada no servidor) continuava no ref, e todo reenvio tentava desativá-la
      // de novo → 409 (already_inactive) → catch → o drawer nunca mais salvava sem fechar e
      // reabrir (o ref só é reconstruído no próximo mount, via `removeRow`).
      while (toDeactivateRef.current.length > 0) {
        const id = toDeactivateRef.current[0];
        await AdminPatientContactRowsApiService.deactivateResponsible(patientId, id);
        toDeactivateRef.current = toDeactivateRef.current.slice(1);
      }

      // 2. Todas as linhas NÃO-titulares primeiro (nunca colidem com o índice único).
      // 3. A linha titular (no máximo uma) por ÚLTIMO — o titular anterior já foi
      //    desmarcado/desativado nos passos 1-2, então promovê-la agora não colide.
      // `i` é o índice no ARRAY DO FORM (`fields`/`rows`), preservado através do reordenamento —
      // é ele que aponta de volta pro `setValue` abaixo.
      const indexadas = rows.map((r, i) => ({ r, i }));
      const ordenadas = [...indexadas.filter(({ r }) => !r.isPrimary), ...indexadas.filter(({ r }) => r.isPrimary)];
      for (const { r, i } of ordenadas) {
        const payload = {
          firstName: r.firstName.trim(),
          lastName: r.lastName.trim(),
          relationship: nz(r.relationship),
          phone: nz(r.phone),
          email: nz(r.email),
          documentType: nz(r.documentType),
          documentNumber: nz(r.documentNumber),
          isPrimary: r.isPrimary,
        };
        if (r.id) {
          await AdminPatientContactRowsApiService.updateResponsible(patientId, r.id, payload);
        } else {
          // ACHADO 2 (018/PR-1): a linha nasce sem id (POST). Sem gravar o id REAL devolvido
          // de volta no form, um retry após a falha de OUTRA linha reenviava esta como POST de
          // novo — cada tentativa duplicava as linhas que já tinham sido criadas com sucesso.
          const created = await AdminPatientContactRowsApiService.createResponsible(patientId, payload);
          setValue(`responsibles.${i}.id`, created.id);
        }
      }
      // `onSaved()` sempre relê a lista do servidor — a tela nunca mostra o snapshot de ANTES do
      // submit, que mentiria sobre o que já foi salvo (achado do gate `revisao-pr`).
      onSaved();
      handleClose();
    } catch {
      // Falha em qualquer chamada (desativação do passo 1 ou criação/atualização do passo 2/3)
      // aborta o laço aqui — próximo Guardar reenvia a partir de onde parou (o id já gravado
      // no form evita duplicar a linha que já tinha sido criada com sucesso).
      onSaved();
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

          {fields.map((f, index) => {
            // Linha EXISTENTE (tem id) exige `update`; linha NOVA (recém-adicionada, sem id)
            // exige `create` — a mesma célula que autorizou o `append` abaixo.
            const isExistingRow = !!watched?.[index]?.id;
            const rowEditable = isExistingRow ? canUpdateRow : canCreateRow;
            return (
            <div key={f.id} data-testid={`psn-row-${index}`} className="flex flex-col gap-3 p-4 rounded-xl border border-slate-200">
              <div className="flex items-center justify-between">
                <Text size="sm" weight="semibold" color="secondary">{te('responsible')} {index + 1}</Text>
                {rowEditable && (
                  <button type="button" onClick={() => removeRow(index)} aria-label={te('removeResponsible')} data-testid={`psn-remove-${index}`} className="text-red-400 hover:text-red-600 transition-colors p-1 rounded">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label={te('firstName')} htmlFor={`psn-firstName-${index}`} required error={terr(errors.responsibles?.[index]?.firstName?.message)}>
                  <InputWithIcon id={`psn-firstName-${index}`} inputSize="compact" disabled={!rowEditable} data-testid={`psn-firstName-${index}`} {...register(`responsibles.${index}.firstName` as const)} />
                </FormField>
                <FormField label={te('lastName')} htmlFor={`psn-lastName-${index}`} required error={terr(errors.responsibles?.[index]?.lastName?.message)}>
                  <InputWithIcon id={`psn-lastName-${index}`} inputSize="compact" disabled={!rowEditable} data-testid={`psn-lastName-${index}`} {...register(`responsibles.${index}.lastName` as const)} />
                </FormField>
                <FormField label={te('relationship')} htmlFor={`psn-rel-${index}`} optional>
                  <Controller control={control} name={`responsibles.${index}.relationship` as const} render={({ field }) => (
                    <SelectField id={`psn-rel-${index}`} inputSize="compact" disabled={!rowEditable} options={relationshipOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`psn-rel-${index}`} />
                  )} />
                </FormField>
                <FormField label={te('phone')} htmlFor={`psn-phone-${index}`} optional>
                  <InputWithIcon id={`psn-phone-${index}`} inputSize="compact" disabled={!rowEditable} data-testid={`psn-phone-${index}`} {...register(`responsibles.${index}.phone` as const)} />
                </FormField>
                <FormField label={te('email')} htmlFor={`psn-email-${index}`} optional error={errors.responsibles?.[index]?.email?.message}>
                  <InputWithIcon id={`psn-email-${index}`} type="email" inputSize="compact" disabled={!rowEditable} data-testid={`psn-email-${index}`} {...register(`responsibles.${index}.email` as const)} />
                </FormField>
                <FormField label={te('documentType')} htmlFor={`psn-documentType-${index}`} optional>
                  <Controller control={control} name={`responsibles.${index}.documentType` as const} render={({ field }) => (
                    <SelectField id={`psn-documentType-${index}`} inputSize="compact" disabled={!rowEditable} options={documentTypeOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`psn-documentType-${index}`} />
                  )} />
                </FormField>
                <FormField label={te('documentNumber')} htmlFor={`psn-documentNumber-${index}`} optional>
                  <InputWithIcon id={`psn-documentNumber-${index}`} inputSize="compact" disabled={!rowEditable} data-testid={`psn-documentNumber-${index}`} {...register(`responsibles.${index}.documentNumber` as const)} />
                </FormField>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="psn-primary"
                  checked={!!watched?.[index]?.isPrimary}
                  onChange={() => selectPrimary(index)}
                  disabled={!rowEditable}
                  data-testid={`psn-primary-${index}`}
                  className="accent-primary w-4 h-4"
                />
                <Text as="span" size="sm" color="secondary">{te('isPrimary')}</Text>
              </label>
            </div>
            );
          })}

          {/* D269: adicionar linha nova é POST → patient_family:create — quem só tem `update`
              não vê o botão (edita as linhas existentes, mas não cria linha). */}
          <ActionButton
            resource="patient_family"
            action="create"
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ id: '', firstName: '', lastName: '', relationship: '', phone: '', email: '', documentType: '', documentNumber: '', isPrimary: fields.length === 0 })}
            className="flex items-center gap-1 w-fit"
            data-testid="psn-add"
          >
            <Plus className="w-4 h-4" />
            {te('addResponsible')}
          </ActionButton>

          {submitError && <Text size="sm" className="text-red-600" data-testid="psn-error">{submitError}</Text>}
        </form>
      </div>
    </>
  );
}
