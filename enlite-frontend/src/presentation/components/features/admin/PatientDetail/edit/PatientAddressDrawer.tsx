import { useEffect, useRef, useState } from 'react';
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
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { useGooglePlacesAutocomplete } from '@presentation/hooks/useGooglePlacesAutocomplete';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';

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
 * Domicílio na ficha (spec 012, US-B2). Criar reusa o MESMO `POST /patients/:id/addresses`
 * do wizard de vaga (`AdminApiService.createPatientAddress`); editar troca só zona
 * (`neighborhood`), corredor e acesso por `PATCH /patients/:id/addresses/:addressId`. A nota
 * de acesso é texto livre sobre a casa de um paciente: `data-clarity-mask` no wrapper; o erro
 * nunca ecoa o que foi digitado (lex C2.3).
 *
 * ── Autocomplete de endereço (PEND-06 da ata de 09/09/2026) ────────────────────────────────
 * O endereço NASCE de uma escolha na lista do Google, nunca de texto digitado à mão —
 * decisão do Gabriel em 10/09, contra a recomendação do `lex` (condição C4, que pedia texto
 * livre por minimização) e pelo ramo que a própria C4 abre: justificativa escrita. A razão é
 * erro de digitação — endereço torto vira vaga publicada no lugar errado e prestador enviado
 * à porta errada. ⚠️ O preço, conhecido e aceito: domicílio que o Google não conhece (zona
 * rural, rua sem numeração) não entra por esta tela.
 *
 * ⚠️ O mapa NÃO geocodifica mais o que se digita (lex C3). Antes, `ServiceAreaMap` recebia o
 * texto do campo e chamava o Geocoder a CADA tecla, sem debounce — 19 letras, 19 chamadas
 * (D289). Agora a coordenada vem no Place Details da escolha (`fields: geometry`), e enquanto
 * não houver escolha o mapa fica no placeholder. Menos ida ao Google, não mais.
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
  /** `required` = campo vazio; `notPicked` = digitado sem escolher da lista do Google. */
  const [addressMissing, setAddressMissing] = useState<'required' | 'notPicked' | null>(null);
  /**
   * DUAS perguntas diferentes, e de propósito em dois estados:
   *  • `pickedFromList` — a operadora escolheu uma linha da lista do Google? É isto, e só
   *    isto, que autoriza gravar.
   *  • `coords` — a escolha trouxe coordenada? Nem todo place do Google traz `geometry`.
   * Juntar as duas num campo só faria "escolheu, mas sem coordenada" ser lido como "não
   * escolheu", e um endereço legítimo ficaria barrado sem motivo visível — o modo de falha
   * da D302. Sem coordenada o mapa fica no placeholder e o servidor geocodifica no insert,
   * que é o que ele já faz hoje.
   */
  const [pickedFromList, setPickedFromList] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);

  // Arrow inline de propósito: o hook lê a versão mais recente por ref. `enabled` desliga o
  // widget no modo edição, onde o campo nem é renderizado — sem isto o drawer baixaria o
  // script do Maps para nada e ainda acenderia "erro ao carregar" num campo ausente.
  const { apiError: autocompleteError } = useGooglePlacesAutocomplete({
    inputRef: addressInputRef,
    enabled: !editing,
    // ⚠️ Aqui o chute é PROIBIDO. Enter sem escolher devolve um place só com `name`, e
    // resolver a 1ª predição gravaria um domicílio que a operadora nunca viu — de cara
    // validado. Medido contra o Google real em 10/09; sem isto a escolha obrigatória é
    // decorativa para quem usa teclado.
    guessFirstPredictionOnEnter: false,
    onPlaceApplied: (place) => {
      setFormatted(place.formatted_address as string);
      setAddressMissing(null);
      setPickedFromList(true);
      const loc = place.geometry?.location;
      setCoords(loc ? { lat: loc.lat(), lng: loc.lng() } : null);
    },
  });

  // Digitar de novo desfaz a escolha: o texto deixa de corresponder à coordenada, e gravar
  // um endereço com a coordenada de OUTRO manda o prestador para a porta errada.
  const handleAddressTyped = (typed: string): void => {
    setFormatted(typed);
    setPickedFromList(false);
    setCoords(null);
  };

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => { setShow(false); setTimeout(onClose, CLOSE_MS); };

  // Spec 014 (US-D4, lex D4 AUTORIZADO): editando, só os 3 campos de logística contam
  // (o endereço em si é somente-leitura aqui); criando, qualquer campo preenchido conta.
  const isDirty = editing
    ? neighborhood !== (address.neighborhood ?? '') ||
      corridor !== (address.logisticsCorridor ?? '') ||
      access !== (address.accessNotes ?? '')
    : formatted !== '' || raw !== '' || type !== 'secondary' || neighborhood !== '' || corridor !== '' || access !== '';

  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
    isDirty,
    onConfirmedClose: handleClose,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

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
    if (!f) { setAddressMissing('required'); return; }
    // Escolha da lista é obrigatória (ver o bloco de autocomplete no topo). Texto digitado
    // que não veio de uma escolha NÃO grava: é o erro de digitação que esta tela existe
    // para não deixar passar.
    if (!pickedFromList) { setAddressMissing('notPicked'); return; }
    setAddressMissing(null);
    // ⚠️ lex C5: `place_id` NÃO entra aqui. Ele é identificador estável do Google para a
    // residência do paciente; persistir cria categoria de dado que hoje não existe no banco.
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
      {confirmingClose && <DiscardChangesConfirm onKeepEditing={keepEditing} onDiscard={confirmDiscard} />}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={requestClose}
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
            <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
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
              <FormField
                label={ta('address')}
                htmlFor="pad-address"
                required
                hint={ta('addressPickHint')}
                hintBelow
                error={addressMissing ? ta(addressMissing === 'required' ? 'addressRequired' : 'addressNotPicked') : undefined}
              >
                {/* O texto digitado é o domicílio de um paciente: o Clarity não grava (lex C1).
                    A LISTA de sugestões é mascarada no próprio nó pelo hook — ela é pendurada
                    no <body>, fora deste wrapper. */}
                <div data-clarity-mask="True">
                  <InputWithIcon
                    ref={addressInputRef}
                    id="pad-address"
                    inputSize="compact"
                    value={formatted}
                    onChange={(e) => handleAddressTyped(e.target.value)}
                    aria-invalid={addressMissing ? 'true' : 'false'}
                    data-testid="pad-address"
                  />
                </div>
              </FormField>
              {/* Sem o Google no ar não existe escolha, e sem escolha não se grava endereço
                  nenhum. Calar aqui deixaria a operadora presa num "escolha da lista" que ela
                  não tem como cumprir — o beco sem saída silencioso. Ela precisa saber que o
                  problema não é ela, e a quem recorrer. */}
              {autocompleteError && (
                <Text size="sm" className="text-amber-700" data-testid="pad-autocomplete-down">
                  {ta('addressAutocompleteDown')}
                </Text>
              )}
              <FormField label={ta('addressRaw')} htmlFor="pad-raw" optional>
                <InputWithIcon id="pad-raw" inputSize="compact" value={raw} onChange={(e) => setRaw(e.target.value)} data-testid="pad-raw" />
              </FormField>
              <FormField label={ta('type')} htmlFor="pad-type" optional>
                <SelectField id="pad-type" inputSize="compact" options={typeOptions} value={type} onChange={setType} data-testid="pad-type" />
              </FormField>
            </>
          )}

          {/* O mapa: editando, coordenada do servidor (e, só para linha legada sem coordenada,
              uma geocodificação única do endereço já gravado). Criando, SÓ a coordenada que veio
              junto com a escolha na lista — nada do que se digita vai ao Google (lex C3). */}
          <div className="h-56 rounded-xl overflow-hidden border border-slate-200" data-clarity-mask="True" data-testid="pad-map">
            <ServiceAreaMap
              lat={editing ? address.lat ?? null : coords?.lat ?? null}
              lng={editing ? address.lng ?? null : coords?.lng ?? null}
              address={editing ? address.addressFormatted ?? address.addressRaw : null}
              className="h-full"
            />
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
