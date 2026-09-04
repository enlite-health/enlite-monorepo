/**
 * B1 (D268) — `authz.features[país][key]` como regra de UI, no mesmo espírito
 * de `useCellAccess`: um hook, uma verdade.
 *
 * Ao contrário de `useCellAccess` (fail-CLOSED — célula ausente = hidden),
 * aqui a régua é assimétrica de propósito (D268): fail-OPEN por MAPA (mapa
 * ausente/vazio, ou sem um país único do ator → renderiza, `console.warn` UMA
 * vez por sessão) e fail-CLOSED só por CHAVE (mapa presente e a chave decide
 * `enabled:false` → some do DOM). Um manifest incompleto não pode apagar tela
 * que ninguém decidiu tirar; uma decisão explícita de `false` tem que valer.
 */
import { useEffect } from 'react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { featureEnabledFor, type FeatureDecision } from '@domain/entities/Authz';

/** Motivos que disparam o warn — os de fail-open. `enabled`/`disabled` são decisão normal, silenciosa. */
const MOTIVOS_FAIL_OPEN: ReadonlySet<FeatureDecision['reason']> = new Set([
  'missing-map',
  'missing-key',
  'no-actor-country',
]);

/** Dedup por (motivo, chave) — module-scope, então "uma vez por sessão" (reload de página = nova sessão). */
const jaAvisado = new Set<string>();

function avisarUmaVez(reason: FeatureDecision['reason'], featureKey: string): void {
  const dedupKey = `${reason}:${featureKey}`;
  if (jaAvisado.has(dedupKey)) return;
  jaAvisado.add(dedupKey);
  // eslint-disable-next-line no-console
  console.warn(
    `[useFeature] fail-open (${reason}) para "${featureKey}" — renderizando por padrão. ` +
      'Mapa de features ausente/incompleto ou ator sem país único no contrato.',
  );
}

export function useFeature(featureKey: string): boolean {
  const features = useAdminAuthStore((s) => s.authz?.features ?? null);
  const countries = useAdminAuthStore((s) => s.authz?.countries ?? null);
  const decision = featureEnabledFor(features, countries, featureKey);

  useEffect(() => {
    if (MOTIVOS_FAIL_OPEN.has(decision.reason)) avisarUmaVez(decision.reason, featureKey);
  }, [decision.reason, featureKey]);

  return decision.enabled;
}
