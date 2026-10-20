/**
 * ContractItem — um contrato na lista do cartão Contratos (spec 058 §4.3): nome, país, abrangência, termo vigente (valor-hora e imposto
 * em %), "sem termo vigente hoje" (`NO_TERM`) + os termos futuros, e o "Novo termo" inline.
 *
 * "Novo termo" sobre um termo VIVO é um reajuste (`supersede` com `REPRICED`: o trecho anterior fica, o novo vale dali em diante);
 * sobre um contrato sem termo vigente (`NO_TERM`) é um termo novo simples. O preço vem redigido (`REDACTED`) sem
 * `patient_contract_value:read`; o imposto nunca é redigido.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import type { ContractTermView, InsuranceContractItem, InsuranceTermBody } from '@domain/entities/InsuranceContract';
import { contractTermTexts } from '@presentation/components/features/admin/PatientDetail/contractedServicePriceText';
import { insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { formatCalendarDate } from './calendar';
import { ContractTermForm } from './ContractTermForm';

const NS = 'admin.insuranceProviders.contracts';

type OkTerm = Extract<ContractTermView, { state: 'OK' }>;

function TermLine({ term, language, testId }: { term: OkTerm; language: string; testId: string }): JSX.Element {
  const { t } = useTranslation();
  const { price, tax } = contractTermTexts(t, term, language);
  const validity = term.validTo
    ? t(`${NS}.validityRange`, { from: formatCalendarDate(term.validFrom), to: formatCalendarDate(term.validTo) })
    : t(`${NS}.validityOpen`, { from: formatCalendarDate(term.validFrom) });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-1" data-testid={testId}>
      <Text color="tertiary" as="span" size="sm" data-testid={`${testId}-price`}><Text as="span" size="xs" color="inherit" className="text-slate-600">{t(`${NS}.hourlyRate`)}: </Text>{price}</Text>
      <Text color="tertiary" as="span" size="sm" data-testid={`${testId}-tax`}><Text as="span" size="xs" color="inherit" className="text-slate-600">{t(`${NS}.tax`)}: </Text>{tax}</Text>
      <Text color="tertiary" as="span" size="sm" data-testid={`${testId}-validity`}><Text as="span" size="xs" color="inherit" className="text-slate-600">{t(`${NS}.validity`)}: </Text>{validity}</Text>
    </div>
  );
}

interface Props {
  contract: InsuranceContractItem;
  onChanged: () => void;
}

export function ContractItem({ contract, onChanged }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const futures = contract.futureTerms.filter((f): f is OkTerm => f.state === 'OK');
  const current = contract.currentTerm;

  async function saveTerm(body: InsuranceTermBody): Promise<void> {
    try {
      setSubmitting(true);
      setError(null);
      if (current.state === 'OK') {
        await AdminInsuranceApiService.supersedeTerm(contract.id, current.termId, { ...body, reason: 'REPRICED' });
      } else {
        await AdminInsuranceApiService.addTerm(contract.id, body);
      }
      setFormOpen(false);
      onChanged();
    } catch (err: unknown) {
      setError(insuranceErrorText(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  const tid = `contract-${contract.id}`;
  return (
    <article className="rounded-xl border border-slate-300 p-4 flex flex-col gap-3" data-testid={tid}>
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Text as="span" size="base" weight="semibold" color="primary" data-testid={`${tid}-name`}>{contract.name}</Text>
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700" data-testid={`${tid}-country`}>
              {t(`${NS}.countryOptions.${contract.country}`)}
            </span>
          </div>
          <Text as="span" size="xs" color="inherit" className="text-slate-600" data-testid={`${tid}-scope`}>{contract.scopeDescription ?? t(`${NS}.scopeNone`)}</Text>
        </div>
        {!formOpen && (
          <ActionButton resource="patient_contract_value" action="create" variant="outline" size="sm" onClick={() => { setError(null); setFormOpen(true); }} className="flex items-center gap-1" data-testid={`${tid}-new-term`}>
            {t(`${NS}.newTerm`)}
            <Plus className="w-4 h-4" />
          </ActionButton>
        )}
      </div>

      {current.state === 'OK' ? (
        <div className="flex flex-col gap-1">
          <Text as="span" size="xs" color="inherit" className="text-slate-600">{t(`${NS}.currentTerm`)}</Text>
          <TermLine term={current} language={i18n.language} testId={`${tid}-current`} />
        </div>
      ) : (
        // NO_TERM: nenhum termo vale hoje — a frase é o estado, não um valor em branco.
        <Text color="inherit" as="span" size="sm" className="text-amber-800" data-testid={`${tid}-no-term`}>{t(`${NS}.noTermToday`)}</Text>
      )}

      {futures.length > 0 && (
        <div className="flex flex-col gap-1" data-testid={`${tid}-future`}>
          <Text as="span" size="xs" color="inherit" className="text-slate-600" data-testid={`${tid}-future-count`}>{t(`${NS}.futureTerms`, { count: futures.length })}</Text>
          {futures.map((f) => (
            <TermLine key={f.termId} term={f} language={i18n.language} testId={`${tid}-future-${f.termId}`} />
          ))}
        </div>
      )}

      {formOpen && (
        <ContractTermForm
          asOf={contract.asOf}
          submitting={submitting}
          error={error}
          onSubmit={saveTerm}
          onCancel={() => setFormOpen(false)}
          testIdPrefix={`${tid}-term-`}
        />
      )}
    </article>
  );
}
