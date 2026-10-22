import type { TFunction } from 'i18next';
import type { CurrentCoverageSummary } from '@domain/entities/PatientDetail';

const K = 'admin.patients.detail.identityCard.';

/**
 * Spec 064: texto da cobertura atual (serviços ativos). Partes juntas com " · ":
 * nomes dos provedores, "Particular", "Obra social (sem acesso ao nome)" e, se já há outra
 * parte, "N serviço(s) sem obra social". Sem serviço ativo / só não vinculados têm texto próprio.
 */
export function currentCoverageText(t: TFunction, summary: CurrentCoverageSummary): string {
  if (summary.activeServices === 0) return t(`${K}currentCoverageNoService`);
  const parts: string[] = [];
  if (summary.providers.length > 0) parts.push(summary.providers.map((p) => p.name).join(', '));
  if (summary.privateServices > 0) parts.push(t(`${K}currentCoveragePrivate`));
  if (summary.hiddenServices > 0) parts.push(t(`${K}currentCoverageHidden`));
  if (parts.length === 0) return t(`${K}currentCoverageUnlinked`);
  if (summary.unlinkedServices > 0) parts.push(t(`${K}currentCoverageSomeUnlinked`, { count: summary.unlinkedServices }));
  return parts.join(' · ');
}
