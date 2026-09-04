import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useFeature } from '@presentation/hooks/useFeature';

interface FeatureRouteGateProps {
  feature: string;
  children: ReactNode;
}

/**
 * B2 (D268) — a versão de ROTA do `FeatureGate`: em vez de sumir do DOM (não
 * dá pra "sumir" uma rota, o usuário já navegou pra ela), redireciona para o
 * índice admin. Mesma postura que `AccessGate` já usa para `hidden` (a URL
 * não é porta) — decisão do plano: redirecionar, não uma tela "indisponível
 * no seu país" nova, para não duplicar texto/i18n por família de rota.
 */
export function FeatureRouteGate({ feature, children }: FeatureRouteGateProps): JSX.Element {
  const enabled = useFeature(feature);
  if (!enabled) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}
