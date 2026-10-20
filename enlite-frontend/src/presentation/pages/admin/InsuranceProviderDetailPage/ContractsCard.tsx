/**
 * ContractsCard — cartão "Contratos" (spec 058 §4.3): lista, "Novo contrato" com o 1º termo e, em cada contrato, o "Novo termo".
 * Todo o resto da regra (imposto obrigatório, sobreposição, país imutável, tipo do pagador) é do back; aqui só se traduz a recusa.
 *
 * `PAYER_KIND_REQUIRED` (422): criar contrato de um pagador ainda não classificado. A tela mostra o texto da spec e um link para o
 * cartão Dados gerais (rola até ele e abre a edição) — não só a frase.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import type { CreateInsuranceContractBody } from '@domain/entities/InsuranceContract';
import { insuranceErrorCode, insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { ContractForm } from './ContractForm';
import { ContractItem } from './ContractItem';
import { CardMessage, ProviderCard } from './ProviderCard';
import { isForbidden, useCardLoad } from './useCardLoad';

const NS = 'admin.insuranceProviders';

interface Props {
  code: string;
  /** Rola até o cartão Dados gerais e abre a edição (o link do `PAYER_KIND_REQUIRED`). */
  onGoToGeneral: () => void;
}

export function ContractsCard({ code, onGoToGeneral }: Props): JSX.Element {
  const { t } = useTranslation();
  const readGate = useActionGate('insurance_contracts', 'read');
  const termGate = useActionGate('patient_contract_value', 'create');
  const { data, error, loading, reload } = useCardLoad(() => AdminInsuranceApiService.listContracts(code), readGate.allowed, [code]);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [payerKindRequired, setPayerKindRequired] = useState(false);

  const noRead = readGate.denied || isForbidden(error);
  const contracts = data ?? [];

  async function create(body: CreateInsuranceContractBody): Promise<void> {
    try {
      setSubmitting(true);
      setFormError(null);
      setPayerKindRequired(false);
      await AdminInsuranceApiService.createContract(code, body);
      setFormOpen(false);
      reload();
    } catch (err: unknown) {
      if (insuranceErrorCode(err) === 'PAYER_KIND_REQUIRED') {
        setPayerKindRequired(true);
        setFormError(t(`${NS}.contracts.payerKindRequired`));
      } else {
        setFormError(insuranceErrorText(t, err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // O contrato nasce com o 1º termo na mesma chamada, e o termo exige `patient_contract_value:create`: sem as duas células o botão some.
  const actions = noRead || !termGate.allowed ? null : (
    <ActionButton resource="insurance_contracts" action="create" variant="outline" size="sm" onClick={() => { setFormError(null); setPayerKindRequired(false); setFormOpen(true); }} className="flex items-center gap-1" data-testid="contracts-new">
      {t(`${NS}.contracts.newContract`)}
      <Plus className="w-4 h-4" />
    </ActionButton>
  );

  return (
    <ProviderCard id="provider-contracts-card" title={t(`${NS}.contracts.title`)} actions={actions}>
      {noRead ? (
        <CardMessage testId="contracts-no-permission">{t(`${NS}.contracts.noPermission`)}</CardMessage>
      ) : (
        <>
          {formOpen && (
            <>
              <ContractForm submitting={submitting} error={formError} onSubmit={create} onCancel={() => setFormOpen(false)} />
              {payerKindRequired && (
                <div data-testid="contracts-payer-kind-required">
                  <Button variant="outline" size="sm" onClick={onGoToGeneral} data-testid="contracts-go-general">
                    {t(`${NS}.contracts.goToGeneral`)}
                  </Button>
                </div>
              )}
            </>
          )}
          {loading ? (
            <TableSkeleton />
          ) : error ? (
            <CardMessage testId="contracts-load-error" tone="error">{insuranceErrorText(t, error)}</CardMessage>
          ) : contracts.length === 0 ? (
            <CardMessage testId="contracts-empty">{t(`${NS}.contracts.empty`)}</CardMessage>
          ) : (
            <div className="flex flex-col gap-3" data-testid="contracts-list">
              {contracts.map((c) => (
                <ContractItem key={c.id} contract={c} onChanged={reload} />
              ))}
            </div>
          )}
        </>
      )}
    </ProviderCard>
  );
}
