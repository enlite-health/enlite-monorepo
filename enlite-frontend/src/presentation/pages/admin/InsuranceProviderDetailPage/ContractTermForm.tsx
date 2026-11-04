/**
 * ContractTermForm — modal do "novo termo" / "corrigir termo" de um contrato (spec 058 §4.3): valor-hora, imposto, vigência.
 * O imposto nasce vazio e obrigatório; o início sugerido e a data mínima são o `asOf` do contrato.
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { InsuranceTermBody } from '@domain/entities/InsuranceContract';
import { FormModal } from './FormModal';
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
    <FormModal
      title={t(correction ? 'admin.insuranceProviders.contracts.termForm.correctTitle' : 'admin.insuranceProviders.contracts.termForm.title')}
      isDirty={state.dirty}
      onClose={onCancel}
      busy={submitting}
      testId={`${testIdPrefix}form`}
      saveLabel={t(correction ? 'admin.insuranceProviders.contracts.termForm.correctSubmit' : 'admin.insuranceProviders.contracts.termForm.submit')}
      onSave={() => {
        const body = state.submit();
        if (body) onSubmit(body);
      }}
      saving={submitting}
      saveTestId={`${testIdPrefix}submit`}
      notice={error && <Text size="sm" className="text-red-600" role="alert" data-testid={`${testIdPrefix}error`}>{error}</Text>}
    >
      <TermFields state={state} asOf={asOf} testIdPrefix={testIdPrefix} enforceMin={!correction} />
    </FormModal>
  );
}
