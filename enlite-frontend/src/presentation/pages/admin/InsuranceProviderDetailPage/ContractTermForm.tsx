/**
 * ContractTermForm — formulário inline do "novo termo" de um contrato (spec 058 §4.3): valor-hora, imposto, vigência.
 * Sem popup (D-48). O imposto nasce vazio e obrigatório; o início sugerido e a data mínima são o `asOf` do contrato.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { InsuranceTermBody } from '@domain/entities/InsuranceContract';
import { TermFields } from './TermFields';
import { useTermDraft, type TermDraft } from './termDraft';

interface Props {
  asOf: string;
  submitting: boolean;
  /** Frase de erro do envio anterior (já traduzida). */
  error: string | null;
  onSubmit: (body: InsuranceTermBody) => void;
  onCancel: () => void;
  testIdPrefix: string;
  /** Correção de um termo: valores de partida (sem o imposto), outro título/botão e sem data mínima. */
  correction?: { initial: Partial<TermDraft> };
}

export function ContractTermForm({ asOf, submitting, error, onSubmit, onCancel, testIdPrefix, correction }: Props): JSX.Element {
  const { t } = useTranslation();
  const state = useTermDraft(asOf, correction?.initial);

  return (
    <div className="rounded-xl border border-slate-300 bg-gray-50 p-4 flex flex-col gap-4" data-testid={`${testIdPrefix}form`}>
      <Heading level={3} weight="semibold" color="primary">{t(correction ? 'admin.insuranceProviders.contracts.termForm.correctTitle' : 'admin.insuranceProviders.contracts.termForm.title')}</Heading>
      <TermFields state={state} asOf={asOf} testIdPrefix={testIdPrefix} enforceMin={!correction} />
      {error && (
        <div role="alert" data-testid={`${testIdPrefix}error`} className="border border-red-300 bg-red-50 rounded-lg px-3 py-2">
          <Text color="inherit" size="sm" className="text-red-700">{error}</Text>
        </div>
      )}
      <div className="flex items-center gap-3 justify-end">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting} data-testid={`${testIdPrefix}cancel`}>
          {t('admin.insuranceProviders.detail.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          isLoading={submitting}
          onClick={() => {
            const body = state.submit();
            if (body) onSubmit(body);
          }}
          data-testid={`${testIdPrefix}submit`}
        >
          {t(correction ? 'admin.insuranceProviders.contracts.termForm.correctSubmit' : 'admin.insuranceProviders.contracts.termForm.submit')}
        </Button>
      </div>
    </div>
  );
}
