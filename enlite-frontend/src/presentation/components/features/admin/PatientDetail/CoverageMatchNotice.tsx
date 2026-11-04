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
const BADGE_BASE = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[12.5px] font-medium leading-snug';
/** Texto/fundo medidos (WCAG): MATCH #14532d/#effaf2 = 8,51:1 · MISMATCH #78350f/#fff8e6 = 8,56:1 · neutro #2c2840/#f3f2f7 = 12,7:1. */
const BADGE_TONE = {
  MATCH: 'text-[#14532d] bg-[#effaf2] border-[#bfe5cb]',
  MISMATCH: 'text-[#78350f] bg-[#fff8e6] border-[#f1d79a]',
  NEUTRAL: 'text-[#2c2840] bg-[#f3f2f7] border-[#e3e0ec]',
} as const;

interface Props {
  state: CoverageMatchState;
  testId?: string;
  /** Selo (pílula colorida) no lugar da frase solta — o cartão "vigente hoy" do drawer de serviço. Default: a frase, como sempre. */
  badge?: boolean;
}

export function CoverageMatchNotice({ state, testId = 'svc-coverage-match', badge = false }: Props): JSX.Element {
  const { t } = useTranslation();
  if (badge) {
    const tone = state === 'MATCH' ? BADGE_TONE.MATCH : state === 'MISMATCH' ? BADGE_TONE.MISMATCH : BADGE_TONE.NEUTRAL;
    return (
      <span className={`font-lexend ${BADGE_BASE} ${tone}`} data-testid={testId} data-state={state}>
        {t(`${CARD}.coverageMatch.${state}`)}
      </span>
    );
  }
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
