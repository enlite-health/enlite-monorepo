import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientAddressDetail, PatientAddressLogisticsPayload } from '@domain/entities/PatientDetail';
import type { PatientAddressCreateInput } from '@domain/entities/PatientAddress';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { ServiceAreaMap } from '@presentation/components/molecules/ServiceAreaMap';

interface Props {
  patientId: string;
  /** Presente = editar a logística deste endereço; ausente = criar um endereço novo. */
  address?: PatientAddressDetail;
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;
const ADDRESS_TYPES = ['primary', 'secondary', 'service'] as const;
/** Teto de `access_notes` — espelha o servidor (lex C2.6). */
export const ACCESS_NOTES_MAX = 2000;

/**
 * Domicílio na ficha (spec 012, US-B2). Criar reusa o MESMO `POST /patients/:id/addresses` do
 * wizard de vaga (`AdminApiService.createPatientAddress`) e o mesmo mapa (`ServiceAreaMap`, que
 * geocodifica no cliente enquanto se digita); editar troca só zona (`neighborhood`), corredor e
 * acesso por `PATCH /patients/:id/addresses/:addressId`. A nota de acesso é texto livre sobre a
 * casa de um paciente: `data-clarity-mask` no wrapper; o erro nunca ecoa o que foi digitado (lex C2.3).
 */
export function PatientAddressDrawer({ patientId, address, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const ta = (k: string) => t(`admin.patients.detail.addressDrawer.${k}`);
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const editing = !!address;

  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [formatted, setFormatted] = useState('');
  const [raw, setRaw] = useState('');
  const [type, setType] = useState<string>('secondary');
  const [neighborhood, setNeighborhood] = useState(address?.neighborhood ?? '');
  const [corridor, setCorridor] = useState(address?.logisticsCorridor ?? '');
  const [access, setAccess] = useState(address?.accessNotes ?? '');
  const [addressMissing, setAddressMissing] = useState(false);

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

  const typeOptions: SelectOption[] = ADDRESS_TYPES.map((v) => ({ value: v, label: ta(`type_${v}`) }));
  const nz = (v: string): string | null => { const s = v.trim(); return s ? s : null; };

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    if (editing) {
      const payload: PatientAddressLogisticsPayload = {};
      if (nz(neighborhood) !== (address.neighborhood ?? null)) payload.neighborhood = nz(neighborhood);
      if (nz(corridor) !== (address.logisticsCorridor ?? null)) payload.logistics_corridor = nz(corridor);
      if (nz(access) !== (address.accessNotes ?? null)) payload.access_notes = nz(access);
      if (Object.keys(payload).length === 0) { handleClose(); return; }
      setBusy(true);
      try {
        await AdminApiService.updatePatientAddressLogistics(patientId, address.id, payload);
        onSaved();
        handleClose();
      } catch {
        setSubmitError(te('saveError'));
      } finally {
        setBusy(false);
      }
      return;
    }

    const f = formatted.trim();
    if (!f) { setAddressMissing(true); return; }
    setAddressMissing(false);
    const payload: PatientAddressCreateInput = { address_formatted: f, address_type: type };
    if (nz(raw)) payload.address_raw = nz(raw) as string;
    if (nz(neighborhood)) payload.neighborhood = nz(neighborhood) as string;
    if (nz(corridor)) payload.logistics_corridor = nz(corridor) as string;
    if (nz(access)) payload.access_notes = nz(access) as string;
    setBusy(true);
    try {
      await AdminApiService.createPatientAddress(patientId, payload);
      onSaved();
      handleClose();
    } catch {
      // lex C2.3: mensagem genérica — a resposta do servidor pode carregar a linha inteira.
      setSubmitError(te('saveError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="patient-address-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? ta('editTitle') : ta('createTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-address-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{editing ? ta('editTitle') : ta('createTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button type="button" variant="primary" size="sm" onClick={onSubmit} isLoading={busy} className="w-32" data-testid="pad-save">
              {te('save')}
            </Button>
            <button type="button" onClick={handleClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          {editing ? (
            <div data-clarity-mask="True" data-testid="pad-address-readonly">
              <Text size="sm" weight="medium" color="secondary">{ta('address')}</Text>
              <Text size="sm" color="muted">{address.addressFormatted ?? address.addressRaw ?? '—'}</Text>
            </div>
          ) : (
            <>
              <FormField label={ta('address')} htmlFor="pad-address" required error={addressMissing ? ta('addressRequired') : undefined}>
                <InputWithIcon id="pad-address" inputSize="compact" value={formatted} onChange={(e) => setFormatted(e.target.value)} aria-invalid={addressMissing ? 'true' : 'false'} data-testid="pad-address" />
              </FormField>
              <FormField label={ta('addressRaw')} htmlFor="pad-raw" optional>
                <InputWithIcon id="pad-raw" inputSize="compact" value={raw} onChange={(e) => setRaw(e.target.value)} data-testid="pad-raw" />
              </FormField>
              <FormField label={ta('type')} htmlFor="pad-type" optional>
                <SelectField id="pad-type" inputSize="compact" options={typeOptions} value={type} onChange={setType} data-testid="pad-type" />
              </FormField>
            </>
          )}

          {/* O mapa: coordenadas do servidor quando editando; geocodificação no cliente enquanto se digita. */}
          <div className="h-56 rounded-xl overflow-hidden border border-slate-200" data-clarity-mask="True" data-testid="pad-map">
            <ServiceAreaMap lat={address?.lat ?? null} lng={address?.lng ?? null} address={editing ? (address.addressFormatted ?? address.addressRaw) : formatted} className="h-full" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
            <FormField label={ta('neighborhood')} htmlFor="pad-neighborhood" optional>
              <InputWithIcon id="pad-neighborhood" inputSize="compact" value={neighborhood} onChange={(e) => setNeighborhood(e.target.value)} data-testid="pad-neighborhood" />
            </FormField>
            <FormField label={ta('corridor')} htmlFor="pad-corridor" optional>
              <InputWithIcon id="pad-corridor" inputSize="compact" value={corridor} onChange={(e) => setCorridor(e.target.value)} data-testid="pad-corridor" />
            </FormField>
          </div>
          <FormField label={ta('accessNotes')} htmlFor="pad-access" optional>
            {/* Texto livre sobre o domicílio do paciente: o Clarity não grava (lex C2.4). */}
            <div data-clarity-mask="True">
              <Textarea id="pad-access" inputSize="compact" resize="vertical" rows={4} maxLength={ACCESS_NOTES_MAX} value={access} onChange={(e) => setAccess(e.target.value)} data-testid="pad-access" />
            </div>
          </FormField>

          {submitError && <Text size="sm" className="text-red-600" data-testid="pad-error">{submitError}</Text>}
        </div>
      </div>
    </>
  );
}
