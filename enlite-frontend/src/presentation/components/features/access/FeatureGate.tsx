import type { ReactNode } from 'react';
import { useFeature } from '@presentation/hooks/useFeature';

interface FeatureGateProps {
  /** A chave `namespace:nome` do manifest (`country-features.manifest.ts`), ex. `screen:talentum`. */
  feature: string;
  children: ReactNode;
}

/**
 * O mesmo formato do `Gated` (B1/D268), para país/feature em vez de célula.
 * `useFeature` já decide fail-open/fail-closed — este componente só aplica a
 * decisão na árvore: `false` remove o filho do DOM (não é `disabled`).
 */
export function FeatureGate({ feature, children }: FeatureGateProps): JSX.Element | null {
  const enabled = useFeature(feature);
  if (!enabled) return null;
  return <>{children}</>;
}
