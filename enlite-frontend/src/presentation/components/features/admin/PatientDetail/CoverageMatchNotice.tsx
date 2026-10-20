import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { CoverageMatchState } from '@domain/entities/PatientContractedService';

const CARD = 'admin.patients.detail.contractedServicesCard';

/** Só a divergência pede atenção; os demais estados são informação (e `REDACTED` é "não li", nunca "tudo bem"). */
const ATTENTION: ReadonlySet<CoverageMatchState> = new Set<CoverageMatchState>(['MISMATCH']);

/**
 * A divergência pagador × cobertura verificada, no serviço (spec 058 §D, §4.5): os 6 estados do back + `REDACTED`
 * (o ator não lê `coverage`). O card de cobertura NÃO mostra isto — a divergência é do serviço.
 */
export function CoverageMatchNotice({ state, testId = 'svc-coverage-match' }: { state: CoverageMatchState; testId?: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Text
      as="span"
      size="sm"
      color="inherit"
      className={ATTENTION.has(state) ? 'text-amber-700' : 'text-slate-600'}
      data-testid={testId}
      data-state={state}
    >
      {t(`${CARD}.coverageMatch.${state}`)}
    </Text>
  );
}
