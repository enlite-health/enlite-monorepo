import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { Button } from '@presentation/components/atoms/Button';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { insuranceErrorCode, insuranceErrorText, NEEDS_CORRECTION, NEEDS_NEW_SERVICE } from '@presentation/utils/insuranceErrors';
import { ContractCascade } from './ContractCascade';
import { ContractedServiceCoverageSummary } from './ContractedServiceCoverageSummary';
import { ContractChangeChooser, type ChangeAnswer } from './ContractChangeChooser';
import { EMPTY_CASCADE, type ContractCascadeValue } from './contractCascadeValue';
import { AvisoAmbar } from './AvisoAmbar';

const CARD = 'admin.patients.detail.contractedServicesCard';

type Mode = 'view' | 'link' | 'switch' | 'correct' | 'end';
/** O botão primário de cada formulário leva o nome da AÇÃO que a resposta escolhida dispara. */
const SAVE_LABEL = { switch: 'actions.switch', correct: 'actions.correct', end: 'actions.end' } as const;

interface Props {
  patientId: string;
  service: PatientContractedServiceDetail;
  /** Recebe o SERVIÇO que a API devolveu (a resposta do vínculo é o serviço projetado para o ator). */
  onChanged: (saved: PatientContractedServiceDetail) => void;
  /** `REQUIRES_NEW_SERVICE`: "vir por outro plano é outra admissão" — o pai abre o formulário de serviço novo. */
  onRequestNewService?: () => void;
  /** Erro do vínculo que falhou logo depois de criar o serviço (a criação deu certo; o vínculo, não). */
  initialError?: unknown;
}

/**
 * O contrato do serviço, dentro do container "serviço contratado" (spec 058 §1.5, §4.4). Opção A (21/10/2026): o cartão "vigente hoy"
 * + UM botão que abre "¿Qué pasó con la cobertura?" — cada resposta leva a UMA ação da regra e mostra só o formulário dela.
 * - sem vínculo: `NO_CONTRACT` + "Vincular obra social y contrato" (cascata Obra social -> Contrato);
 * - com vínculo: obra social TRAVADA (muda só por correção); trocar de contrato = `SWITCHED`, corrigir = `CORRECTION`, terminar = `end`;
 * - preço e imposto SÓ exibidos (vêm do termo vigente); `REDACTED` sem permissão;
 * - `REQUIRES_NEW_SERVICE` / `USE_CORRECTION` viram frase + botão (criar serviço / corrigir), nunca um erro mudo.
 */
export function ContractedServiceContractPanel({ patientId, service, onChanged, onRequestNewService, initialError }: Props): JSX.Element {
  const { t } = useTranslation();
  const { allowed: canCreateService } = useActionGate('patient_services', 'create');
  const [mode, setMode] = useState<Mode>('view');
  const [value, setValue] = useState<ContractCascadeValue>(EMPTY_CASCADE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(initialError ?? null);

  const payer = service.payer;
  const linked = payer.state === 'LINKED' ? payer : null;
  // Vínculo VIVO que só começa depois do `asOf`: `payer` diz NO_CONTRACT, mas o banco já recusa um "Vincular" novo (USE_CORRECTION).
  const scheduled = linked ? null : (service.payerHistory.filter((h) => h.validFrom > service.asOf).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0] ?? null);
  const live = linked ?? scheduled;
  const names = live?.names ?? null;
  const hasHistory = service.payerHistory.length > 0;
  const code = error ? insuranceErrorCode(error) : null;
  const disabled = busy || !service.active;
  const defaultEnd = scheduled ? scheduled.validFrom : service.asOf;
  const [endTo, setEndTo] = useState(defaultEnd);
  // `chooser` = a pergunta aberta (só com vínculo); `mode` = o formulário da resposta escolhida (ou o de vincular).
  const [chooser, setChooser] = useState(false);

  const close = (): void => { setMode('view'); setChooser(false); setError(null); };
  const open = (next: Mode): void => {
    setError(null);
    setValue({ ...EMPTY_CASCADE, providerCode: next === 'switch' ? (names?.providerCode ?? '') : '' });
    setEndTo(defaultEnd);
    setChooser(next !== 'link');
    setMode(next);
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const validTo = value.validTo || null;
      let saved: PatientContractedServiceDetail;
      if (mode === 'end') {
        saved = await AdminInsuranceApiService.endContractLink(patientId, service.id, { validTo: endTo });
      } else if (mode === 'link') {
        saved = await AdminInsuranceApiService.createContractLink(patientId, service.id, { contractId: value.contractId, validFrom: value.validFrom, validTo });
      } else {
        saved = await AdminInsuranceApiService.supersedeContractLink(patientId, service.id, {
          reason: mode === 'switch' ? 'SWITCHED' : 'CORRECTION',
          contractId: value.contractId,
          validFrom: value.validFrom,
          validTo,
        });
      }
      setMode('view');
      setChooser(false);
      onChanged(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const formReady = mode === 'end' ? endTo !== '' : value.contractId !== '' && value.validFrom !== '';

  // As respostas PERMITIDAS: as mesmas condições de visibilidade que os botões tinham antes (spec 058 §1.5).
  const answers: ChangeAnswer[] = [];
  if (linked && names) answers.push('switch');
  if (live) answers.push('correct', 'end');
  // Serviço novo = `patient_services:create` (as 4 ações do vínculo pedem só `update`): quem não cria não vê a saída.
  if (live && onRequestNewService && canCreateService) answers.push('newService');

  const choose = (a: ChangeAnswer): void => {
    if (a === 'newService') { onRequestNewService?.(); return; }
    open(a);
  };

  const idle = mode === 'view';
  // Os botões do cartão: com vínculo = o que abre a pergunta; sem vínculo = vincular / criar serviço novo.
  const actions = !idle ? null : live ? (
    !chooser && (
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setChooser(true)} data-testid="svc-contract-change-open">{t(`${CARD}.summary.change`)}</Button>
    )
  ) : service.active && (
    <>
      <Button type="button" variant="primary" size="sm" disabled={disabled} onClick={() => open('link')} data-testid="svc-contract-link-open">{t(`${CARD}.summary.linkCta`)}</Button>
      {hasHistory && onRequestNewService && (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRequestNewService} data-testid="svc-contract-new-service">{t(`${CARD}.actions.newService`)}</Button>
      )}
    </>
  );

  // O formulário da resposta escolhida (ou o de vincular). O botão primário leva o nome da AÇÃO.
  const form = idle ? null : (
    <div className="flex flex-col gap-3" data-testid={`svc-contract-form-${mode}`}>
      {mode === 'end' ? (
        <FormField label={t(`${CARD}.cascade.validTo`)} htmlFor="svc-contract-end-to" labelSize="compact" hint={t(`${CARD}.cascade.validToHint`)} hintBelow>
          <InputWithIcon id="svc-contract-end-to" type="date" inputSize="compact" value={endTo} onChange={(e) => setEndTo(e.target.value)} disabled={busy} data-testid="svc-contract-end-to" />
        </FormField>
      ) : (
        <ContractCascade
          idPrefix="svc-contract"
          country={service.country}
          value={value}
          onChange={setValue}
          // Trocar de contrato mantém a obra social (outra obra social = outro serviço); corrigir pode mudar tudo.
          lockedProvider={mode === 'switch' && names ? { code: names.providerCode, name: names.providerName } : null}
          disabled={busy}
        />
      )}
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <Button type="button" variant="primary" size="sm" isLoading={busy} disabled={!formReady} onClick={submit} data-testid="svc-contract-save">{t(`${CARD}.${mode === 'link' ? 'actions.save' : SAVE_LABEL[mode]}`)}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={close} data-testid="svc-contract-cancel">{t(`${CARD}.actions.cancel`)}</Button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-testid={`svc-contract-panel-${service.id}`}>
      <ContractedServiceCoverageSummary service={service} linked={linked} scheduled={scheduled} actions={actions} />

      {chooser && (answers.length > 0 || !idle) && (
        <div className="flex flex-col gap-3 rounded-xl border border-[#D9D9D9] p-4" data-testid="svc-contract-change-card">
          {answers.length > 0 && (
            <ContractChangeChooser
              answers={answers}
              selected={mode === 'switch' || mode === 'correct' || mode === 'end' ? mode : null}
              providerName={names?.providerName ?? ''}
              onChoose={choose}
              disabled={busy || !service.active}
            />
          )}
          {form}
        </div>
      )}
      {!chooser && mode === 'link' && <div className="rounded-xl border border-[#D9D9D9] p-4">{form}</div>}

      {error !== null && (
        <div className="flex flex-col gap-2" data-testid="svc-contract-error-box">
          <AvisoAmbar testId="svc-contract-error">{insuranceErrorText(t, error)}</AvisoAmbar>
          <div className="flex flex-wrap gap-2">
            {code === NEEDS_NEW_SERVICE && onRequestNewService && (
              <Button type="button" variant="outline" size="sm" onClick={onRequestNewService} data-testid="svc-contract-error-new-service">{t(`${CARD}.actions.newService`)}</Button>
            )}
            {code === NEEDS_CORRECTION && service.active && (
              <Button type="button" variant="outline" size="sm" onClick={() => open('correct')} data-testid="svc-contract-error-correct">{t(`${CARD}.actions.correct`)}</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
