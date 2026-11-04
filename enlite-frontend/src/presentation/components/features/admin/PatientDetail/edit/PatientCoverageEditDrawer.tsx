import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import type { PatientDetail, PatientCoverageSectionPayload } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';
import { CoverageEmergencyContactsEditor } from './CoverageEmergencyContactsEditor';
import { invalidCoverageContacts, type EditableCoverageEmergencyContact } from './coverageContactValidation';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

/**
 * Drawer "Cobertura Médica" (spec 012, US-B3; spec 087): nº de afiliado (Credencial) e contatos de emergência da cobertura. Salva por
 * PATCH /:id/coverage só o que mudou. A cobertura ATUAL (obra social/Particular) e a "verificada" NÃO são editadas aqui: a cobertura vive
 * no serviço contratado (vínculo com contrato), e o PATCH recusa `insuranceVerifiedCodes` com 400. IVA e tipo de contratação NÃO estão
 * aqui (lex C3.3 → bloco C).
 */
export function PatientCoverageEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.coverageCard.${k}`, o);
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [affiliate, setAffiliate] = useState(patient.affiliateId ?? '');

  // 417/PR-1 (spec 018, ADR-1): contatos de emergência da cobertura — escrita POR LINHA. `id`
  // presente = linha existente (o submit decide update/deactivate por diff); `null` (sem célula) e
  // backend anterior à 417 (ausente) começam vazios.
  const initialContacts: EditableCoverageEmergencyContact[] = (patient.coverageEmergencyContacts ?? []).map(({ id, kind, name, phone }) => ({ id, kind, name, phone }));
  const [contacts, setContacts] = useState<EditableCoverageEmergencyContact[]>(initialContacts);
  const contactsKey = (l: EditableCoverageEmergencyContact[]) => JSON.stringify(l.map((c) => [c.id, c.kind, c.name.trim(), c.phone.trim()]));
  const contactsDirty = contactsKey(contacts) !== contactsKey(initialContacts);
  const contactsInvalid = invalidCoverageContacts(contacts);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => { setShow(false); setTimeout(onClose, CLOSE_MS); };

  // Spec 014 (US-D4, lex D4 AUTORIZADO): dirty = algum campo mudou vs. o valor com que o drawer abriu.
  const isDirty =
    affiliate !== (patient.affiliateId ?? '') ||
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

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };
    const payload: PatientCoverageSectionPayload = {};
    if (nz(affiliate) !== (patient.affiliateId ?? null)) payload.affiliateId = nz(affiliate);
    if (Object.keys(payload).length === 0 && !contactsDirty) { handleClose(); return; }

    setBusy(true);
    try {
      if (Object.keys(payload).length > 0) {
        await AdminApiService.updatePatientSection(patient.id, 'coverage', payload);
      }
      // Contatos de emergência da cobertura: escrita POR LINHA (spec 018, PR-1, ADR-1) — diff
      // contra o que o drawer abriu com. Removidas primeiro (nada aqui colide com índice único
      // como em responsáveis, mas a ordem "sai antes de entrar" é a mesma disciplina).
      if (contactsDirty) {
        const initialIds = new Set(initialContacts.map((c) => c.id).filter(Boolean));
        const currentIds = new Set(contacts.map((c) => c.id).filter(Boolean));
        for (const id of initialIds) {
          if (!currentIds.has(id)) await AdminPatientContactRowsApiService.deactivateCoverageEmergencyContact(patient.id, id);
        }
        // ACHADO 2 (018/PR-1): cada linha nova nasce sem `id` (POST). Sem gravar de volta o id
        // REAL devolvido pela API, um retry após a falha de OUTRA linha reenviava esta como POST
        // de novo — cada tentativa duplicava as linhas já criadas com sucesso. `setContacts` com
        // updater funcional edita SÓ o índice que acabou de ser criado, sem perder o que a pessoa
        // já tiver digitado nas outras linhas enquanto a chamada estava em voo.
        for (let index = 0; index < contacts.length; index += 1) {
          const c = contacts[index];
          const trimmed = { kind: c.kind, name: c.name.trim(), phone: c.phone.trim() };
          if (!c.id) {
            const created = await AdminPatientContactRowsApiService.createCoverageEmergencyContact(patient.id, trimmed);
            setContacts((prev) => prev.map((row, i) => (i === index ? { ...row, id: created.id } : row)));
          } else {
            const original = initialContacts.find((o) => o.id === c.id);
            const changed = !original || original.kind !== trimmed.kind || original.name.trim() !== trimmed.name || original.phone.trim() !== trimmed.phone;
            if (changed) await AdminPatientContactRowsApiService.updateCoverageEmergencyContact(patient.id, c.id, trimmed);
          }
        }
      }
      // `onSaved()` sempre relê a lista do servidor — a tela nunca mostra o snapshot de ANTES do
      // submit, que mentiria sobre o que já foi salvo (achado do gate `revisao-pr`).
      onSaved();
      handleClose();
    } catch (err) {
      // Falha em qualquer chamada (desativação, criação/atualização de linha, ou o PATCH de
      // `coverage`) aborta aqui — próximo Guardar reenvia a partir de onde parou (o id já
      // gravado no estado evita duplicar a linha que já tinha sido criada com sucesso).
      onSaved();
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
          <FormField label={tc('credential')} htmlFor="pcv-affiliate" hint={te('affiliateHint')} optional>
            <InputWithIcon id="pcv-affiliate" inputSize="compact" value={affiliate} onChange={(e) => setAffiliate(e.target.value)} data-testid="pcv-affiliate" />
          </FormField>
          {/* `null` = sem `patient_coverage:read` (o servidor recusa a escrita com 403 de qualquer forma); a lista não é oferecida. */}
          {patient.coverageEmergencyContacts === null
            ? <Text size="xs" className="text-amber-700" data-testid="pcv-contacts-redacted">{te('coverageContactsRedacted')}</Text>
            : <CoverageEmergencyContactsEditor value={contacts} onChange={setContacts} disabled={busy} allowDirectProfessional={patient.coverageDirectProfessionalRedacted === false} />}
          {submitError && <Text size="sm" className="text-red-600" data-testid="pcv-error">{submitError}</Text>}
        </div>
      </div>
    </>
  );
}
