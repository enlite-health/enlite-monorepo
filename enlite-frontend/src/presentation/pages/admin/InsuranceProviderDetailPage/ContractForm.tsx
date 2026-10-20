/**
 * ContractForm — "novo contrato + 1º termo" (spec 058 §1.3/§4.3). O país decide a moeda e é imutável depois; o "hoje" do país
 * (`asOf`) vem da API assim que o país é escolhido (`for-service`) — nunca do relógio do navegador.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { Field } from './Field';
import { FormModal } from './FormModal';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import { CONTRACT_COUNTRIES, type ContractCountry, type CreateInsuranceContractBody } from '@domain/entities/InsuranceContract';
import { TermFields } from './TermFields';
import { useTermDraft } from './termDraft';

interface Props {
  submitting: boolean;
  error: string | null;
  /** Ação extra logo abaixo do erro (o botão "Ir para Dados gerais" do `PAYER_KIND_REQUIRED`). */
  errorAction?: ReactNode;
  onSubmit: (body: CreateInsuranceContractBody) => void;
  onCancel: () => void;
}

const NS = 'admin.insuranceProviders.contracts';
const PREFIX = 'contract-new-';

export function ContractForm({ submitting, error, errorAction, onSubmit, onCancel }: Props): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [country, setCountry] = useState<ContractCountry | ''>('');
  const [scope, setScope] = useState('');
  const [asOf, setAsOf] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const term = useTermDraft(asOf);

  // O "hoje" do país escolhido, da API (`for-service` devolve `asOf` mesmo sem nenhuma obra social na lista).
  useEffect(() => {
    setAsOf(null);
    if (country === '') return undefined;
    let cancelled = false;
    AdminInsuranceApiService.listProvidersForService(country)
      .then((res) => { if (!cancelled) setAsOf(res.asOf); })
      .catch(() => { /* sem `asOf` o termo não pode ser salvo; a frase "escolha o país" segue na tela */ });
    return () => { cancelled = true; };
  }, [country]);

  function handleSubmit(): void {
    const body = term.submit();
    if (name.trim() === '' || country === '') {
      setMissing(true);
      return;
    }
    setMissing(false);
    if (!body) return;
    onSubmit({
      name: name.trim(),
      country,
      ...(scope.trim() !== '' ? { scopeDescription: scope.trim() } : {}),
      firstTerm: body,
    });
  }

  const isDirty = name !== '' || country !== '' || scope !== '' || term.dirty;

  return (
    <FormModal title={t(`${NS}.contractForm.title`)} isDirty={isDirty} onClose={onCancel} busy={submitting} testId="contract-new-form"
      saveLabel={t('admin.insuranceProviders.detail.save')}
      onSave={handleSubmit}
      saving={submitting}
      saveTestId="contract-new-submit"
      notice={(missing || error) && (
        <>
          {missing && <Text size="sm" className="text-red-600" role="alert" data-testid="contract-new-required">{t(`${NS}.contractForm.required`)}</Text>}
          {error && <Text size="sm" className="text-red-600" role="alert" data-testid="contract-new-error">{error}</Text>}
          {error && errorAction}
        </>
      )}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t(`${NS}.contractForm.name`)} required htmlFor="contract-new-name">
          <Input inputSize="compact" id="contract-new-name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} data-testid="contract-new-name" />
        </Field>
        <Field label={t(`${NS}.contractForm.country`)} required htmlFor="contract-new-country">
          <Select
            inputSize="compact"
            id="contract-new-country"
            value={country}
            placeholder={t(`${NS}.contractForm.countryPlaceholder`)}
            options={CONTRACT_COUNTRIES.map((c) => ({ value: c, label: t(`${NS}.countryOptions.${c}`) }))}
            onValueChange={(v) => setCountry(v as ContractCountry | '')}
            data-testid="contract-new-country"
          />
        </Field>
        <Field label={t(`${NS}.contractForm.scope`)} optional hint={t(`${NS}.contractForm.scopeHelp`)} htmlFor="contract-new-scope" className="sm:col-span-2">
          <Textarea inputSize="compact" id="contract-new-scope" rows={2} value={scope} onChange={(e) => setScope(e.target.value)} data-testid="contract-new-scope" />
        </Field>
      </div>
      <Heading level={3} weight="semibold" color="primary">{t(`${NS}.contractForm.firstTerm`)}</Heading>
      <TermFields state={term} asOf={asOf} testIdPrefix={PREFIX} />
    </FormModal>
  );
}
