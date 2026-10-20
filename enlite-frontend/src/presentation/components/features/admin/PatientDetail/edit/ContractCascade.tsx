import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import { CONTRACT_COUNTRIES, type InsuranceContractItem } from '@domain/entities/InsuranceContract';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { contractTermTexts } from '../contractedServicePriceText';
import { AvisoAmbar } from './AvisoAmbar';
import type { ContractCascadeValue } from './contractCascadeValue';

const CARD = 'admin.patients.detail.contractedServicesCard';

interface Props {
  /** Prefixo dos testids (`<prefix>-provider`, `-contract`, `-valid-from`, `-valid-to`, `-term-preview`). */
  idPrefix: string;
  /** País do SERVIÇO: só as obras sociais com contrato oferecido nele entram. */
  country: string | null | undefined;
  value: ContractCascadeValue;
  onChange: (next: ContractCascadeValue) => void;
  /** Obra social travada (vínculo já existe: ela só muda por correção). O nome mostrado vem do banco. */
  lockedProvider?: { code: string; name: string } | null;
  disabled?: boolean;
}

/**
 * Cascata Obra social -> Contrato do serviço contratado (spec 058 §1.5, §4.4). Dentro do container "serviço contratado".
 *
 * - Obra social: GET `/insurance-providers/for-service?country=` (só as ATIVAS com contrato oferecido no país; o nome é do banco, C3).
 * - Contrato: GET `/insurance-providers/:code/contracts?offered=true` (só os que têm termo oferecido).
 * - Vigência do vínculo: o início sugerido é o `asOf` DA RESPOSTA (o "hoje" do país vem do back; o front não calcula data).
 * - Preço e imposto do contrato escolhido só aparecem (prévia read-only); `REDACTED` sem permissão.
 */
export function ContractCascade({ idPrefix, country, value, onChange, lockedProvider = null, disabled = false }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const [providers, setProviders] = useState<SelectOption[]>([]);
  const [contracts, setContracts] = useState<InsuranceContractItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  const validCountry = country && (CONTRACT_COUNTRIES as readonly string[]).includes(country) ? country : null;

  // Obras sociais do país. O `asOf` da resposta vira o início sugerido do vínculo (só se ainda não há um).
  useEffect(() => {
    if (!validCountry) return;
    let cancelled = false;
    AdminInsuranceApiService.listProvidersForService(validCountry, lockedProvider?.code)
      .then(({ providers: list, asOf }) => {
        if (cancelled) return;
        setProviders(list.map((p) => ({ value: p.code, label: p.name })));
        setProvidersLoaded(true);
        setLoadError(null);
        if (!value.validFrom) onChange({ ...value, validFrom: asOf });
      })
      .catch((err) => { if (!cancelled) setLoadError(insuranceErrorText(t, err)); });
    return () => { cancelled = true; };
    // `value`/`onChange` ficam fora de propósito: só o país e a obra social travada recarregam a lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validCountry, lockedProvider?.code]);

  const providerCode = lockedProvider?.code ?? value.providerCode;

  // Contratos oferecidos da obra social escolhida.
  useEffect(() => {
    if (!providerCode || !validCountry) { setContracts([]); return; }
    let cancelled = false;
    AdminInsuranceApiService.listContracts(providerCode, { offered: true, country: validCountry })
      .then((items) => { if (!cancelled) { setContracts(items); setLoadError(null); } })
      .catch((err) => { if (!cancelled) { setContracts([]); setLoadError(insuranceErrorText(t, err)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerCode, validCountry]);

  const providerOptions = useMemo<SelectOption[]>(
    () => (lockedProvider && !providers.some((p) => p.value === lockedProvider.code)
      ? [{ value: lockedProvider.code, label: lockedProvider.name }, ...providers]
      : providers),
    [providers, lockedProvider],
  );
  const contractOptions = useMemo<SelectOption[]>(() => contracts.map((c) => ({ value: c.id, label: c.name })), [contracts]);
  const chosen = contracts.find((c) => c.id === value.contractId) ?? null;
  const preview = chosen ? contractTermTexts(t, chosen.currentTerm.state === 'OK' ? chosen.currentTerm : (chosen.futureTerms[0] ?? chosen.currentTerm), i18n.language) : null;

  if (!validCountry) {
    return <AvisoAmbar testId={`${idPrefix}-no-country`}>{t(`${CARD}.cascade.noCountry`)}</AvisoAmbar>;
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`${idPrefix}-cascade`}>
      {loadError && <AvisoAmbar testId={`${idPrefix}-load-error`}>{loadError}</AvisoAmbar>}
      {providersLoaded && providerOptions.length === 0 && !loadError && (
        <AvisoAmbar testId={`${idPrefix}-no-providers`}>{t(`${CARD}.cascade.noProviders`)}</AvisoAmbar>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label={t(`${CARD}.cascade.provider`)} htmlFor={`${idPrefix}-provider`} optional>
          <SelectField
            id={`${idPrefix}-provider`}
            inputSize="compact"
            options={providerOptions}
            placeholder={t('admin.patients.editDrawer.selectPlaceholder')}
            value={providerCode}
            // Trocar a obra social zera o contrato: a lista de um não vale para o outro.
            onChange={(code) => onChange({ ...value, providerCode: code, contractId: '' })}
            disabled={disabled || lockedProvider !== null}
            data-testid={`${idPrefix}-provider`}
          />
        </FormField>
        <FormField label={t(`${CARD}.cascade.contract`)} htmlFor={`${idPrefix}-contract`} optional>
          <SelectField
            id={`${idPrefix}-contract`}
            inputSize="compact"
            options={contractOptions}
            placeholder={t('admin.patients.editDrawer.selectPlaceholder')}
            value={value.contractId}
            onChange={(id) => onChange({ ...value, contractId: id })}
            disabled={disabled || !providerCode}
            data-testid={`${idPrefix}-contract`}
          />
        </FormField>
        <FormField label={t(`${CARD}.cascade.validFrom`)} htmlFor={`${idPrefix}-valid-from`} optional>
          <InputWithIcon
            id={`${idPrefix}-valid-from`}
            type="date"
            inputSize="compact"
            value={value.validFrom}
            onChange={(e) => onChange({ ...value, validFrom: e.target.value })}
            disabled={disabled}
            data-testid={`${idPrefix}-valid-from`}
          />
        </FormField>
        <FormField label={t(`${CARD}.cascade.validTo`)} htmlFor={`${idPrefix}-valid-to`} optional hint={t(`${CARD}.cascade.validToHint`)} hintBelow>
          <InputWithIcon
            id={`${idPrefix}-valid-to`}
            type="date"
            inputSize="compact"
            value={value.validTo}
            onChange={(e) => onChange({ ...value, validTo: e.target.value })}
            disabled={disabled}
            data-testid={`${idPrefix}-valid-to`}
          />
        </FormField>
      </div>
      {chosen && preview && (
        <div className="flex flex-wrap gap-x-6 gap-y-1" data-testid={`${idPrefix}-term-preview`}>
          <Text as="span" size="sm" color="secondary">{t(`${CARD}.tableValue`)}: <Text as="span" size="sm" weight="medium" data-testid={`${idPrefix}-preview-price`}>{preview.price}</Text></Text>
          <Text as="span" size="sm" color="secondary">{t(`${CARD}.tableIVA`)}: <Text as="span" size="sm" weight="medium" data-testid={`${idPrefix}-preview-tax`}>{preview.tax}</Text></Text>
        </div>
      )}
    </div>
  );
}
