import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail, PatientCoverageSectionPayload } from '@domain/entities/PatientDetail';
import { INSURANCE_PROVIDER_CODES } from '@domain/entities/patientEnums';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import type { SelectOption } from '@presentation/components/molecules/SelectField';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';
import { CoverageEmergencyContactsEditor, invalidCoverageContacts } from './CoverageEmergencyContactsEditor';
import type { PatientCoverageEmergencyContactInput } from '@domain/entities/PatientCoverage';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

/** Origem que o painel NÃO edita neste drawer — chip travado (QA 🟡3/SUP-B5). */
const LOCKED_SOURCE = 'clickup';

/**
 * Drawer "Cobertura Médica" (spec 012, US-B3): cobertura informada (texto), verificadas por
 * CÓDIGO do catálogo (multi-select — o catálogo é lido do endpoint, editável sem deploy; cai no
 * seed dos 33 se a leitura falhar) e nº de afiliado. Salva por PATCH /:id/coverage, só o que
 * mudou. IVA e tipo de contratação NÃO estão aqui (lex C3.3 → bloco C).
 *
 * QA 🟡3 (SUP-B5): o multi-select edita SÓ as coberturas gravadas pelo PAINEL
 * (`source !== 'clickup'`) — o PATCH (`replaceCodesForPatient`) sempre apagou/regravou apenas
 * `source='admin_manual'`, então desmarcar um código de origem ClickUp aqui nunca o removia de
 * verdade: o operador via "sucesso" e a cobertura voltava no próximo GET (união das origens).
 * As de origem ClickUp aparecem como chips travados (sem controle de remoção), rotulados
 * `te('coverageFromClickup')`. Fallback: se a API não mandar `insuranceVerifiedEntries` (contrato
 * anterior a esta rodada), trata todo `insuranceVerifiedCodes` como editável — mesmo
 * comportamento de antes, sem quebrar quem ainda não fez deploy do backend novo.
 */
export function PatientCoverageEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.detail.coverageCard.${k}`);
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([...INSURANCE_PROVIDER_CODES]);
  const [name, setName] = useState(patient.insuranceInformed ?? '');
  const [affiliate, setAffiliate] = useState(patient.affiliateId ?? '');

  const entries = patient.insuranceVerifiedEntries
    ?? (patient.insuranceVerifiedCodes ?? []).map((code) => ({ code, source: 'admin_manual' }));
  const lockedEntries = entries.filter((e) => e.source === LOCKED_SOURCE);
  const editableInitialCodes = entries.filter((e) => e.source !== LOCKED_SOURCE).map((e) => e.code);

  const [selected, setSelected] = useState<string[]>(editableInitialCodes);
  // 417 (D301.3b): contatos de emergência da cobertura — a lista inteira; `null` (sem célula) e
  // backend anterior à 417 (ausente) começam vazios e SÓ vão no payload se o humano mexer.
  const initialContacts: PatientCoverageEmergencyContactInput[] = (patient.coverageEmergencyContacts ?? []).map(({ kind, name, phone }) => ({ kind, name, phone }));
  const [contacts, setContacts] = useState<PatientCoverageEmergencyContactInput[]>(initialContacts);
  const contactsKey = (l: PatientCoverageEmergencyContactInput[]) => JSON.stringify(l.map((c) => [c.kind, c.name.trim(), c.phone.trim()]));
  const contactsDirty = contactsKey(contacts) !== contactsKey(initialContacts);
  const contactsInvalid = invalidCoverageContacts(contacts);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    AdminApiService.listInsuranceProviders()
      .then((rows) => { if (!cancelled) setCodes(rows.map((r) => r.code)); })
      .catch(() => { /* seed dos 33 já está no estado */ });
    return () => { cancelled = true; };
  }, []);

  const handleClose = (): void => { setShow(false); setTimeout(onClose, CLOSE_MS); };

  // Spec 014 (US-D4, lex D4 AUTORIZADO): dirty = algum campo mudou vs. o valor com que o
  // drawer abriu. `editableInitialCodes` já é a baseline correta (não a união com o ClickUp —
  // ver o comentário da função acima), então comparar `selected` contra ele é a mesma régua
  // que `onSubmit` já usa pra decidir o PATCH.
  const isDirty =
    name !== (patient.insuranceInformed ?? '') ||
    affiliate !== (patient.affiliateId ?? '') ||
    [...selected].sort().join(',') !== [...editableInitialCodes].sort().join(',') ||
    contactsDirty;

  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
    isDirty,
    onConfirmedClose: handleClose,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const labelOf = (code: string) => t(`admin.patients.insuranceProviderOptions.${code}`, code);
  const options: SelectOption[] = codes.map((code) => ({ value: code, label: labelOf(code) }));

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };
    const payload: PatientCoverageSectionPayload = {};
    if (nz(name) !== (patient.insuranceInformed ?? null)) payload.healthInsuranceName = nz(name);
    if (nz(affiliate) !== (patient.affiliateId ?? null)) payload.affiliateId = nz(affiliate);
    // A baseline é o que o PAINEL já tinha gravado (editableInitialCodes) — não a união com o
    // ClickUp. Comparar contra a união faria um "sem mudança nenhuma" no editável disparar um
    // PATCH à toa sempre que houvesse cobertura de origem ClickUp.
    const before = [...editableInitialCodes].sort().join(',');
    if ([...selected].sort().join(',') !== before) payload.insuranceVerifiedCodes = selected;
    if (contactsDirty) payload.emergencyContacts = contacts.map((c) => ({ kind: c.kind, name: c.name.trim(), phone: c.phone.trim() }));
    if (Object.keys(payload).length === 0) { handleClose(); return; }

    setBusy(true);
    try {
      await AdminApiService.updatePatientSection(patient.id, 'coverage', payload);
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
        data-testid="patient-coverage-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={te('coverageTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-coverage-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{te('coverageTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={onSubmit} isLoading={busy} disabled={contactsInvalid} className="w-32" data-testid="pcv-save">
              {te('save')}
            </Button>
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          <FormField label={tc('providerName')} htmlFor="pcv-name" optional>
            <InputWithIcon id="pcv-name" inputSize="compact" value={name} onChange={(e) => setName(e.target.value)} data-testid="pcv-name" />
          </FormField>
          <FormField label={tc('verified')} htmlFor="pcv-codes" optional>
            {lockedEntries.length > 0 && (
              // QA 🟡3: origem ClickUp — chip SEM controle de remoção (não faz parte do
              // multi-select nem do payload). Ver o comentário da função para o porquê.
              <div className="flex flex-wrap gap-1 mb-2" data-testid="pcv-codes-locked">
                {lockedEntries.map(({ code }) => (
                  <span key={code} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    <Text as="span" size="xs" weight="medium" color="inherit">{labelOf(code)}</Text>
                    <Text as="span" size="xs" color="muted">{te('coverageFromClickup')}</Text>
                  </span>
                ))}
              </div>
            )}
            <MultiSelect id="pcv-codes" options={options} value={selected} onChange={setSelected} placeholder={te('selectPlaceholder')} />
            {/* O que está marcado, por extenso: o botão do MultiSelect só diz "N seleccionados". */}
            <div className="flex flex-wrap gap-1 mt-1" data-testid="pcv-codes-selected">
              {selected.map((code) => (
                <span key={code} className="inline-flex px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">
                  <Text as="span" size="xs" weight="medium" color="inherit">{labelOf(code)}</Text>
                </span>
              ))}
            </div>
          </FormField>
          <FormField label={tc('credential')} htmlFor="pcv-affiliate" hint={te('affiliateHint')} optional>
            <InputWithIcon id="pcv-affiliate" inputSize="compact" value={affiliate} onChange={(e) => setAffiliate(e.target.value)} data-testid="pcv-affiliate" />
          </FormField>
          {/* `null` = sem `patient_coverage:read` (o servidor recusa a escrita com 403 de qualquer forma); a lista não é oferecida. */}
          {patient.coverageEmergencyContacts === null
            ? <Text size="xs" className="text-amber-700" data-testid="pcv-contacts-redacted">{te('coverageContactsRedacted')}</Text>
            : <CoverageEmergencyContactsEditor value={contacts} onChange={setContacts} disabled={busy} />}
          {submitError && <Text size="sm" className="text-red-600" data-testid="pcv-error">{submitError}</Text>}
        </div>
      </div>
    </>
  );
}
