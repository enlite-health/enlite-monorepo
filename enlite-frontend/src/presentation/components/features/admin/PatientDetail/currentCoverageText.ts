import type { TFunction } from 'i18next';
import type { CurrentCoverageSummary } from '@domain/entities/PatientDetail';

const K = 'admin.patients.detail.identityCard.';

export type CurrentCoverageDisplay = { kind: 'tags'; names: string[] } | { kind: 'text'; text: string };

/**
 * Spec 064: decide o que "Cobertura actual" mostra — o ÚNICO decisor. Com obra social (e/ou
 * "Particular") devolve `tags`, uma por nome e SÓ o nome (sem contador de serviços sem vínculo);
 * os demais estados são texto simples. `undefined` = backend anterior; `null` = sem permissão.
 */
export function currentCoverageDisplay(
  t: TFunction,
  summary: CurrentCoverageSummary | null | undefined,
): CurrentCoverageDisplay {
  if (summary === undefined) return { kind: 'text', text: t(`${K}unavailable`) };
  if (summary === null) return { kind: 'text', text: t(`${K}noPermission`) };
  if (summary.activeServices === 0) return { kind: 'text', text: t(`${K}currentCoverageNoService`) };
  const names = summary.providers.map((p) => p.name);
  if (summary.privateServices > 0) names.push(t(`${K}currentCoveragePrivate`));
  if (names.length > 0) return { kind: 'tags', names };
  return { kind: 'text', text: t(summary.hiddenServices > 0 ? `${K}currentCoverageHidden` : `${K}currentCoverageUnlinked`) };
}
