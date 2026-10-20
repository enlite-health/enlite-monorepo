import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { insuranceErrorCode, insuranceErrorText, NEEDS_CORRECTION, NEEDS_NEW_SERVICE } from '@presentation/utils/insuranceErrors';
import { formatCalendarDate } from '@presentation/utils/dateTimeFormat';
import { contractedServicePriceText, contractedServiceTaxText } from '../contractedServicePriceText';
import { CoverageMatchNotice } from '../CoverageMatchNotice';
import { ContractCascade } from './ContractCascade';
import { EMPTY_CASCADE, type ContractCascadeValue } from './contractCascadeValue';
import { AvisoAmbar } from './AvisoAmbar';

const CARD = 'admin.patients.detail.contractedServicesCard';

type Mode = 'view' | 'link' | 'switch' | 'correct' | 'end';

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
 * O contrato do serviço, dentro do container "serviço contratado" (spec 058 §1.5, §4.4):
 * - sem vínculo: `NO_CONTRACT` + "Vincular contrato" (cascata Obra social -> Contrato);
 * - com vínculo: obra social TRAVADA (muda só por correção); trocar de contrato = `SWITCHED`, corrigir = `CORRECTION`, terminar = `end`;
 * - preço e imposto SÓ exibidos (vêm do termo vigente); `REDACTED` sem permissão;
 * - `REQUIRES_NEW_SERVICE` / `USE_CORRECTION` viram frase + botão (criar serviço / corrigir), nunca um erro mudo.
 */
export function ContractedServiceContractPanel({ patientId, service, onChanged, onRequestNewService, initialError }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<Mode>('view');
  const [value, setValue] = useState<ContractCascadeValue>(EMPTY_CASCADE);
  const [endTo, setEndTo] = useState(service.asOf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(initialError ?? null);

  const payer = service.payer;
  const linked = payer.state === 'LINKED' ? payer : null;
  const names = linked?.names ?? null;
  const hasHistory = service.payerHistory.length > 0;
  const code = error ? insuranceErrorCode(error) : null;
  const disabled = busy || !service.active;

  const close = (): void => { setMode('view'); setError(null); };
  const open = (next: Mode): void => {
    setError(null);
    setValue({ ...EMPTY_CASCADE, providerCode: next === 'switch' ? (names?.providerCode ?? '') : '' });
    setEndTo(service.asOf);
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
      onChanged(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const formReady = mode === 'end' ? endTo !== '' : value.contractId !== '' && value.validFrom !== '';

  const payerLine = (): string => {
    if (!linked) return t(`${CARD}.payer.none`);
    if (names) return `${names.providerName} — ${names.contractName}`;
    return linked.isPrivate ? t(`${CARD}.payer.private`) : t(`${CARD}.payer.hidden`);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3" data-testid={`svc-contract-panel-${service.id}`}>
      <Text size="sm" weight="semibold" color="secondary">{t(`${CARD}.contractSection`)}</Text>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        <div className="flex flex-col gap-0.5" data-testid="svc-payer" data-state={payer.state}>
          <Text size="xs" color="secondary">{t(`${CARD}.cascade.provider`)} / {t(`${CARD}.cascade.contract`)}</Text>
          <Text size="sm" weight="medium">{payerLine()}</Text>
        </div>
        {linked && (
          <div className="flex flex-col gap-0.5" data-testid="svc-payer-validity">
            <Text size="xs" color="secondary">{t(`${CARD}.cascade.validity`)}</Text>
            <Text size="sm" weight="medium">
              {formatCalendarDate(linked.validFrom, {})}
              {' — '}
              {linked.validTo ? formatCalendarDate(linked.validTo, {}) : t(`${CARD}.cascade.noEnd`)}
            </Text>
          </div>
        )}
        {names?.payerKind && (
          <div className="flex flex-col gap-0.5" data-testid="svc-payer-kind">
            <Text size="xs" color="secondary">{t(`${CARD}.payerKind`)}</Text>
            <Text size="sm" weight="medium">{t(`${CARD}.payerKindOptions.${names.payerKind}`)}</Text>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          <Text size="xs" color="secondary">{t(`${CARD}.tableValue`)}</Text>
          <Text size="sm" weight="medium" data-testid="svc-price">{contractedServicePriceText(t, service.price, i18n.language)}</Text>
        </div>
        <div className="flex flex-col gap-0.5">
          <Text size="xs" color="secondary">{t(`${CARD}.tableIVA`)}</Text>
          <Text size="sm" weight="medium" data-testid="svc-tax">{contractedServiceTaxText(t, service.tax, i18n.language)}</Text>
        </div>
        <div className="flex flex-col gap-0.5 sm:col-span-2">
          <Text size="xs" color="secondary">{t(`${CARD}.coverageMatchLabel`)}</Text>
          <CoverageMatchNotice state={service.coverageMatch.state} />
        </div>
      </div>

      {mode === 'view' && (
        <div className="flex flex-wrap gap-2">
          {!linked && (
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => open('link')} data-testid="svc-contract-link-open">{t(`${CARD}.actions.link`)}</Button>
          )}
          {!linked && hasHistory && onRequestNewService && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRequestNewService} data-testid="svc-contract-new-service">{t(`${CARD}.actions.newService`)}</Button>
          )}
          {linked && (
            <>
              <Button type="button" variant="outline" size="sm" disabled={disabled || !names} onClick={() => open('switch')} data-testid="svc-contract-switch-open">{t(`${CARD}.actions.switch`)}</Button>
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => open('correct')} data-testid="svc-contract-correct-open">{t(`${CARD}.actions.correct`)}</Button>
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => open('end')} data-testid="svc-contract-end-open">{t(`${CARD}.actions.end`)}</Button>
            </>
          )}
        </div>
      )}

      {mode !== 'view' && (
        <div className="flex flex-col gap-3" data-testid={`svc-contract-form-${mode}`}>
          <Text size="sm" color="secondary">{t(`${CARD}.modeHint.${mode}`)}</Text>
          {mode === 'end' ? (
            <FormField label={t(`${CARD}.cascade.validTo`)} htmlFor="svc-contract-end-to" hint={t(`${CARD}.cascade.validToHint`)} hintBelow>
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
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" size="sm" isLoading={busy} disabled={!formReady} onClick={submit} data-testid="svc-contract-save">{t(`${CARD}.actions.save`)}</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={close} data-testid="svc-contract-cancel">{t(`${CARD}.actions.cancel`)}</Button>
          </div>
        </div>
      )}

      {error !== null && (
        <div className="flex flex-col gap-2" data-testid="svc-contract-error-box">
          <AvisoAmbar testId="svc-contract-error">{insuranceErrorText(t, error)}</AvisoAmbar>
          <div className="flex flex-wrap gap-2">
            {code === NEEDS_NEW_SERVICE && onRequestNewService && (
              <Button type="button" variant="outline" size="sm" onClick={onRequestNewService} data-testid="svc-contract-error-new-service">{t(`${CARD}.actions.newService`)}</Button>
            )}
            {code === NEEDS_CORRECTION && linked && (
              <Button type="button" variant="outline" size="sm" onClick={() => open('correct')} data-testid="svc-contract-error-correct">{t(`${CARD}.actions.correct`)}</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
