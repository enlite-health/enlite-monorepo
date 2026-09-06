import { useEffect, useRef, useState } from 'react';
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
import { ClinicalTextareaField } from './ClinicalTextareaField';
import { DEVICE_TYPE_CODES } from '@domain/entities/patientEnums';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';
import { DiagnosisAssignmentSection } from './DiagnosisAssignmentSection';
import { Label } from '@presentation/components/atoms/Label';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const DEPENDENCY_LEVELS = ['SEVERE', 'VERY_SEVERE', 'MODERATE', 'MILD'] as const;
// US-B8 (spec 012, `2026-08-26a#DEC-09`): "Especialidad" SAIU do drawer — o segmento vira máscara
// do projeto terapêutico, derivado do CID; o segmento continua chegando pelo espelho do ClickUp.
const SERVICE_TYPES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
const CLOSE_MS = 300;
/** Teto das observações gerais (REQ-01). O banco é TEXT; o teto é da tela, para o contador ter referência. */
export const GENERAL_NOTES_MAX = 4000;

// tri-state boolean flag as select: '' (unset/null) | 'true' | 'false'
const BOOL_VALUES = ['', 'true', 'false'] as const;

// Todo campo nasce preenchido em `defaultValues` ('' / []) — o tipo diz isso e o submit deixa de
// carregar fallbacks para um `undefined` que nunca chega (mesmo padrão do bloco A, spec 011).
const schema = z.object({
  diagnosis: z.string(),
  additionalComments: z.string().max(GENERAL_NOTES_MAX),
  emergencyInstructions: z.string().max(GENERAL_NOTES_MAX),
  // US-B4: códigos de `device_types` (multi) — texto livre dava 23503 (FK desde a 308).
  deviceTypes: z.array(z.string()),
  dependencyLevel: z.string(),
  serviceType: z.array(z.string()),
  hasJudicialProtection: z.string(),
  hasCud: z.string(),
  hasConsent: z.string(),
});
type FormValues = z.infer<typeof schema>;

function boolToStr(v: boolean | null): string {
  return v === null || v === undefined ? '' : v ? 'true' : 'false';
}
function strToBool(v: string): boolean | null {
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

  const { register, handleSubmit, control, watch, formState: { isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      diagnosis: patient.diagnosis ?? '',
      additionalComments: patient.additionalComments ?? '',
      emergencyInstructions: patient.emergencyInstructions ?? '',
      deviceTypes: patient.deviceTypes ?? [],
      dependencyLevel: patient.dependencyLevel ?? '',
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

  /**
   * Spec 016 F3: cada ação de diagnóstico (escolher/promover/remover) já É o "salvar" — chama a
   * API na hora, fora do submit deste formulário (Contrato de arquitetura: seção própria, sem
   * "salvar em lote"). Só NÃO chamamos `onSaved()` (== `refetch` do pai) a cada ação: medido que
   * `PatientDetailPage` renderiza `<DetailSkeleton />` enquanto `isLoading`, o que DESMONTA a
   * ficha inteira — incluindo este drawer, ainda aberto — a cada refetch. Chamando `onSaved()`
   * por diagnóstico o drawer fechava sozinho no meio da edição (sem passar por handleClose,
   * sem animação, sem chance de escolher um segundo diagnóstico). O refetch fica para quando o
   * drawer REALMENTE fecha — mesmo timing que os outros campos já usam (só ao fechar/salvar).
   */
  const diagnosesChangedRef = useRef(false);
  const closeAndSyncDiagnoses = (): void => {
    if (diagnosesChangedRef.current) onSaved();
    handleClose();
  };

  // Spec 014 (US-D4, lex D4 AUTORIZADO): reusa o `isDirty` que o react-hook-form já calcula.
  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
    isDirty,
    onConfirmedClose: closeAndSyncDiagnoses,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const dependencyOptions: SelectOption[] = DEPENDENCY_LEVELS.map((d) => ({ value: d, label: t(`admin.patients.dependencyOptions.${d}`, { defaultValue: d }) }));
  const deviceOptions: SelectOption[] = DEVICE_TYPE_CODES.map((d) => ({ value: d, label: t(`admin.patients.deviceTypeOptions.${d}`, { defaultValue: d }) }));
  const serviceOptions: SelectOption[] = SERVICE_TYPES.map((s) => ({ value: s, label: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${s}`, { defaultValue: s }) }));
  const boolOptions: SelectOption[] = BOOL_VALUES.map((v) => ({
    value: v,
    label: v === '' ? te('unset') : v === 'true' ? t('common.yes', 'Sí') : t('common.no', 'No'),
  }));

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitError(null);
    const payload: PatientClinicalSectionPayload = {};
    const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };
    if (nz(values.diagnosis) !== (patient.diagnosis ?? null)) payload.diagnosis = nz(values.diagnosis);
    if (nz(values.additionalComments) !== (patient.additionalComments ?? null)) payload.additionalComments = nz(values.additionalComments);
    // Redigido para este ator: o campo nem entra no formulário como valor real — nunca sobrescrever.
    if (!patient.emergencyInstructionsRedacted && nz(values.emergencyInstructions) !== (patient.emergencyInstructions ?? null)) payload.emergencyInstructions = nz(values.emergencyInstructions);
    // Conjunto: só vai quando muda (comparado sem ordem) — "re-salvar sem mudança não altera linhas".
    const devs = values.deviceTypes;
    if ([...devs].sort().join(',') !== [...(patient.deviceTypes ?? [])].sort().join(',')) payload.deviceTypes = devs;
    if (nz(values.dependencyLevel) !== (patient.dependencyLevel ?? null)) payload.dependencyLevel = nz(values.dependencyLevel);
    const svc = values.serviceType;
    if (JSON.stringify(svc) !== JSON.stringify(patient.serviceType ?? [])) payload.serviceType = svc;
    if (strToBool(values.hasJudicialProtection) !== (patient.hasJudicialProtection ?? null)) payload.hasJudicialProtection = strToBool(values.hasJudicialProtection);
    if (strToBool(values.hasCud) !== (patient.hasCud ?? null)) payload.hasCud = strToBool(values.hasCud);
    if (strToBool(values.hasConsent) !== (patient.hasConsent ?? null)) payload.hasConsent = strToBool(values.hasConsent);

    if (Object.keys(payload).length === 0) { closeAndSyncDiagnoses(); return; }

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
        <SelectField inputSize="compact" options={boolOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={testid} />
      )} />
    </FormField>
  );

  return (
    <>
      {confirmingClose && <DiscardChangesConfirm onKeepEditing={keepEditing} onDiscard={confirmDiscard} />}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={requestClose}
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
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          <FormField label={td('diagnosisCard.cid')} htmlFor="pce-diagnosis" optional>
            <InputWithIcon id="pce-diagnosis" inputSize="compact" data-testid="pce-diagnosis" {...register('diagnosis')} />
          </FormField>
          {/* Spec 016 F3 (REQ-21): diagnóstico ESTRUTURADO por CID-11 — busca+chips, código
              nunca visível. Ação própria (POST/PATCH imediato), fora do submit deste formulário. */}
          <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
            <Label htmlFor="icd-search-input">{te('diagnosisAssignment.sectionTitle')}</Label>
            <DiagnosisAssignmentSection
              patientId={patient.id}
              initialDiagnoses={patient.diagnoses}
              onChanged={() => { diagnosesChangedRef.current = true; }}
            />
          </div>
          {/* REQ-01 (D195): "observações gerais" é narrativa clínica — textarea grande com contador e
              máscara do Clarity (lex 29/08, C1.1), dentro de ClinicalTextareaField. */}
          <ClinicalTextareaField
            id="pce-comments"
            label={td('diagnosisCard.generalNotes')}
            rows={8}
            maxChars={GENERAL_NOTES_MAX}
            value={watch('additionalComments')}
            {...register('additionalComments')}
          />
          {/* REQ-01 (D211.2): instruções de emergência — mesmo molde; se o backend redigiu para este
              ator, o campo não é editável (não há valor real para preservar). */}
          <ClinicalTextareaField
            id="pce-emergency"
            label={td('diagnosisCard.emergencyInstructions')}
            rows={6}
            maxChars={GENERAL_NOTES_MAX}
            value={watch('emergencyInstructions')}
            disabled={!!patient.emergencyInstructionsRedacted}
            placeholder={patient.emergencyInstructionsRedacted ? td('diagnosisCard.emergencyRedacted') : undefined}
            {...register('emergencyInstructions')}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label={t('admin.patients.dependencyLabel', { defaultValue: 'Dependencia' })} htmlFor="pce-dependency" optional>
              <Controller control={control} name="dependencyLevel" render={({ field }) => (
                <SelectField inputSize="compact" options={dependencyOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid="pce-dependency" />
              )} />
            </FormField>
            <FormField label={te('deviceType')} htmlFor="pce-device" optional>
              <Controller control={control} name="deviceTypes" render={({ field }) => (
                <MultiSelect options={deviceOptions} value={field.value} onChange={field.onChange} placeholder={te('selectPlaceholder')} id="pce-device" />
              )} />
            </FormField>
            <FormField label={tc('serviceType')} htmlFor="pce-serviceType" optional>
              <Controller control={control} name="serviceType" render={({ field }) => (
                <MultiSelect options={serviceOptions} value={field.value} onChange={field.onChange} placeholder={te('selectPlaceholder')} id="pce-serviceType" />
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
