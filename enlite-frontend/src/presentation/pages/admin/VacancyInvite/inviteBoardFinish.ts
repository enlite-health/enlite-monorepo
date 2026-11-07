import type { SavedCandidate } from '../../../../types/match';
import { BANDS, bandIndexOf, dayInZone, type DistanceStep } from './inviteBoardCore';

// ---------------------------------------------------------------- F5 (DF-20)

export interface FinishSummary {
  total: number;
  /** "Ya en la vacante": convidados hoje que NÃO estão no resultado desta abertura. */
  vacante: number;
  /** faixas com ≥ 1 (as com 0 não aparecem). */
  bands: Array<{ min: number; max: DistanceStep; count: number }>;
  /** do resultado, mas sem faixa (sem distância). */
  noLocation: number;
}

/**
 * F5: candidatos com `messagedAt` no `operationDate` (dia no fuso do país), agrupados. Quem está no
 * resultado desta abertura vai para a faixa da distância; quem não está = "Ya en la vacante" (depois
 * do envio ele deixa de satisfazer o ⚑4, pois `messagedAt` foi gravado). Sem filtro de interruptor.
 */
export function finishSummary(
  candidates: readonly SavedCandidate[],
  currentIds: ReadonlySet<string>,
  operationDate: string,
  timeZone?: string,
): FinishSummary {
  const today = candidates.filter(
    (c) => c.messagedAt != null && dayInZone(c.messagedAt, timeZone) === operationDate,
  );
  const counts = BANDS.map(() => 0);
  let vacante = 0;
  let noLocation = 0;
  for (const c of today) {
    if (!currentIds.has(c.workerId)) {
      vacante += 1;
      continue;
    }
    const i = bandIndexOf(c.distanceKm);
    if (i == null) noLocation += 1;
    else counts[i] += 1;
  }
  return {
    total: today.length,
    vacante,
    bands: BANDS.map((b, i) => ({ min: b.min, max: b.max, count: counts[i] })).filter((b) => b.count > 0),
    noLocation,
  };
}

