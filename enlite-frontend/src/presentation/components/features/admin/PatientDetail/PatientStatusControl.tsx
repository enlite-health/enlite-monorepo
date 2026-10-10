import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientDetail, UpdatePatientStatusPayload } from '@domain/entities/PatientDetail';
import { ON_HOLD_REASONS, isClinicalPatientStatus } from '@domain/entities/patientEnums';
import { usePatientStatusOptions } from '@hooks/admin/usePatientStatusOptions';
import { refusalFromError } from '@domain/entities/PatientStatusRefusal';
import { friendlyStatusMessage, missingItemsLabel } from '@presentation/utils/patientStatusMessages';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { FormField } from '@presentation/components/molecules/FormField';
import { buttonClasses } from '@presentation/components/atoms/Button/buttonClasses';
import { ChevronDown } from 'lucide-react';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { SuspensionExitReasonSelect } from './SuspensionExitReasonSelect';

interface Props {
  patient: PatientDetail;
  /** Called after a successful move so the page can refetch (status badge + Historial). */
  onSaved: () => void;
}

/** Teto de `on_hold_note` — espelha o schema do servidor (lex C7.1-f). */
export const ON_HOLD_NOTE_MAX = 2000;

/**
 * O estado clínico v2 da ficha (spec 012, US-B7): select do estado atual + os destinos que o
 * SERVIDOR devolve (spec 051: GET status-options — fluxo normal mais o que a permissão do ator
 * libera); ON_HOLD abre motivo (obrigatório) + nota. Nada aqui decide FSM nem permissão: destino
 * com `blockedBy` aparece desabilitado com o motivo; se a lista não carregar, o select TRAVA (não
 * volta à lista inteira). A recusa do PUT é traduzida em frase amigável, sem código técnico. Só
 * existe para quem já passou pela admissão; antes disso o caminho é o botão "Activar paciente".
 *
 * A nota é texto clínico restrito (pacote D211.2): `data-clarity-mask` no wrapper, e quando o
 * backend a redigiu para este ator (`onHoldNoteRedacted`) o campo nem é editável — não há valor
 * real para preservar.
 */
export function PatientStatusControl({ patient, onSaved }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const ts = (k: string, opts?: Record<string, string>): string => String(t(`admin.patients.status.${k}`, opts ?? {}));

  const current = patient.status ?? 'ACTIVE';
  const [status, setStatus] = useState<string>(current);
  const [reason, setReason] = useState<string>(patient.onHoldReason ?? '');
  const [note, setNote] = useState<string>(patient.onHoldNote ?? '');
  const [exitReason, setExitReason] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { state: optionsState, reload: reloadOptions } = usePatientStatusOptions(patient.id, 'admin_panel', patient.status, patient.admissionStatus === 'DONE');

  // Lista relida e o destino escolhido saiu dela (permissão revogada, dado mudou): volta ao atual — não
  // deixa o operador salvar o que o servidor já não oferece.
  const offeredNow = optionsState.phase === 'ready' ? optionsState.options.map((o): string => o.status) : null; // lista completa: só confere se o destino escolhido ainda existe
  useEffect(() => {
    if (offeredNow && status !== current && !offeredNow.includes(status)) setStatus(current);
  }, [offeredNow, status, current]);

  if (patient.admissionStatus !== 'DONE') return null;

  const goingOnHold = status === 'ON_HOLD';
  // Saída de SUSPENDED (decisão do Gabriel 29/09/2026): o paciente ESTÁ suspenso e o alvo é
  // outro — motivo obrigatório, catálogo fechado, sem texto livre (a trilha nunca guarda texto
  // clínico). Mesmo molde de `goingOnHold`, espelhado no servidor (PatientStatusWriter).
  const leavingSuspended = current === 'SUSPENDED' && status !== current;
  const changed = status !== current || (goingOnHold && (reason !== (patient.onHoldReason ?? '') || note !== (patient.onHoldNote ?? '')));
  const canSave = changed && (!goingOnHold || reason !== '') && (!leavingSuspended || exitReason !== '') && !busy;

  const label = (s: string) => t(`admin.patients.statusOptions.${s}`, s);
  const reasonOptions: SelectOption[] = ON_HOLD_REASONS.map((r) => ({ value: r, label: t(`admin.patients.onHoldReasonOptions.${r}`, r) }));
  // Estado atual + SÓ o que o servidor devolveu. Sem lista (carregando ou falha) só o atual — nunca o catálogo inteiro.
  const optionsReady = optionsState.phase === 'ready';
  // Recorte de APRESENTAÇÃO da ficha (spec ponto 1: o funil fica como hoje): a lista do servidor pode trazer
  // estados do funil (funil↔funil, estado nulo); o select da ficha só mostra os clínicos. Permissão continua do servidor.
  const offered = optionsState.phase === 'ready' ? optionsState.options.filter((o) => isClinicalPatientStatus(o.status)) : [];
  const statusOptions: Array<{ value: string; label: string; disabled: boolean }> = [
    { value: current, label: label(current), disabled: false },
    ...offered
      .filter((o) => o.status !== current)
      .map((o) => {
        const items = missingItemsLabel(t, o.blockedBy);
        return {
          value: o.status,
          label: items ? ts('blockedOption', { status: label(o.status), items }) : label(o.status),
          disabled: !!o.blockedBy?.length,
        };
      }),
  ];

  const handleSave = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    const payload: UpdatePatientStatusPayload = { status };
    if (goingOnHold) {
      payload.onHoldReason = reason;
      // Redigido para este ator: a CHAVE nem entra no corpo — `onHoldNote: null` é ESCRITA
      // (apaga a nota clínica, sem segunda cópia em lugar nenhum). Mesmo molde dos dois irmãos
      // desta ficha: PatientClinicalEditDrawer (emergencyInstructions) e ContractedServiceFormRow
      // (hourlyValue). O textarea nasce vazio e desabilitado — não há valor real para preservar.
      if (!patient.onHoldNoteRedacted) payload.onHoldNote = note.trim() ? note : null;
    }
    if (leavingSuspended) payload.suspensionExitReason = exitReason;
    try {
      await AdminApiService.updatePatientStatus(patient.id, payload);
      onSaved();
    } catch (err) {
      const api = err instanceof PatientApiError ? err : null;
      // Spec 051 (§6.4): frase amigável, a mesma do Kanban; o código/célula ficam no corpo da resposta.
      const friendly = api ? friendlyStatusMessage(t, refusalFromError(api, status)) : null;
      setError(friendly ?? (err instanceof Error ? err.message : ts('error')));
      // A lista pode ter ficado velha (permissão revogada, dado completado em outra aba): relê.
      if (api && (api.status === 403 || api.status === 422)) reloadOptions();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 min-w-[240px]" data-testid="patient-status-control">
      {/* 06/09 (Gabriel): "pega o que você fez pra me dar como exemplo e coloca no lugar".
          No exemplo os TRÊS controles da barra eram botões iguais — inclusive o do estado, que
          mostrava "Estado: Activo ▾" dentro de um botão só. Na tela ele era outra coisa: um rótulo
          solto MAIS um select com caixa e seta próprias, e por isso o conjunto nunca batia com o
          desenho, por mais que eu acertasse os dois botões das pontas.

          Agora ele É o botão: as classes vêm de `buttonClasses({ variant:'quiet', size:'xs' })` —
          a MESMA função que o atom `Button` usa, não uma cópia que diverge depois. O `<select>`
          fica por cima, transparente, cobrindo a área toda: o clique abre o menu nativo do sistema
          operacional e o teclado continua funcionando. `aria-label` carrega o nome acessível que o
          `<Label>` visível carregava antes. */}
      <div className="flex items-center gap-2">
        {/* 🔒 `focus-within` (lex 06/09, WCAG 2.4.7 AA). O `buttonClasses` traz `focus:ring-2`,
            mas quem recebe o foco aqui é o `<select>` TRANSPARENTE, e o anel está na `div` que o
            envolve — que não é focável. Sem isto, quem navega por teclado não vê onde está.
            O `lex` classificou como item de LISTA, mas conserto agora porque a regressão é DESTA
            branch: antes o select era visível e tinha o foco próprio dele. */}
        <div className={`relative ${buttonClasses({ variant: 'quiet', size: 'xs' })} focus-within:ring-2 focus-within:ring-primary/50`}>
          <span className="whitespace-nowrap">
            {ts('title')}: {label(status)}
          </span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <select
            id="patient-status-select"
            aria-label={ts('title')}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            value={status}
            disabled={!optionsReady}
            onChange={(e) => { setStatus(e.target.value); setError(null); }}
            data-testid="patient-status-select"
          >
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
            ))}
          </select>
        </div>
        <Button type="button" variant="primary" size="xs" onClick={handleSave} disabled={!canSave} isLoading={busy} data-testid="patient-status-save">
          {ts('save')}
        </Button>
      </div>
      {optionsState.phase === 'error' && (
        <div className="flex items-center gap-2" data-testid="patient-status-options-error">
          <Text size="sm" className="text-red-600">{ts('optionsLoadError')}</Text>
          <Button type="button" variant="quiet" size="xs" onClick={reloadOptions} data-testid="patient-status-options-retry">
            {ts('optionsRetry')}
          </Button>
        </div>
      )}
      {goingOnHold && (
        <>
          <FormField label={ts('reason')} htmlFor="patient-status-reason" required>
            <SelectField
              id="patient-status-reason"
              inputSize="compact"
              options={reasonOptions}
              placeholder={t('admin.patients.editDrawer.unset')}
              value={reason}
              onChange={(v) => setReason(v)}
              data-testid="patient-status-reason"
            />
          </FormField>
          <FormField label={ts('note')} htmlFor="patient-status-note" optional>
            {/* Texto clínico restrito (D211.2): o Clarity não pode gravar. */}
            <div data-clarity-mask="True">
              <Textarea
                id="patient-status-note"
                inputSize="compact"
                resize="vertical"
                rows={3}
                maxLength={ON_HOLD_NOTE_MAX}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={!!patient.onHoldNoteRedacted}
                placeholder={patient.onHoldNoteRedacted ? ts('noteRedacted') : ts('notePlaceholder')}
                data-testid="patient-status-note"
              />
            </div>
          </FormField>
        </>
      )}
      {leavingSuspended && (
        <SuspensionExitReasonSelect id="patient-status-exit-reason" value={exitReason} onChange={setExitReason} />
      )}
      {error && <Text size="sm" className="text-red-600" data-testid="patient-status-error">{error}</Text>}
    </div>
  );
}
