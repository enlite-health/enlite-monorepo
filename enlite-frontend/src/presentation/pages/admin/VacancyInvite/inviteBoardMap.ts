import type { SavedCandidate } from '../../../../types/match';
import {
  DISTANCE_STEPS, MAX_RADIUS_KM, bandIndexOfStep, bandOfStep, hasLocation, inBand, isInvited, isStepCompleted,
  isVisible, matchResult, selectedIds, stepCandidates,
  type BoardContext, type DistanceStep, type StepId,
} from './inviteBoardCore';

const COLOR = {
  brand: '#F227AF',
  navy: '#180149',
  white: '#ffffff',
  invitedBorder: '#737373',
} as const;

// ---------------------------------------------------------------- mapa

export type RingTone = 'current' | 'done' | 'idle';
export interface RingSpec {
  radiusKm: DistanceStep;
  tone: RingTone;
}

/** Vacante: 4 anéis idle. Distância `i`: anéis 0..i; anel concluído = done, senão atual (i) ou idle. */
export function stepRings(ctx: BoardContext, step: StepId): RingSpec[] {
  if (step === 'vacante') return DISTANCE_STEPS.map((radiusKm) => ({ radiusKm, tone: 'idle' as const }));
  const upTo = bandIndexOfStep(step);
  return DISTANCE_STEPS.slice(0, upTo + 1).map((radiusKm) => ({
    radiusKm,
    tone: isStepCompleted(ctx, radiusKm) ? 'done' : radiusKm === step ? 'current' : 'idle',
  }));
}

export const fitRadiusKmOf = (step: StepId): number =>
  step === 'vacante' ? MAX_RADIUS_KM : bandOfStep(step).max;

export type PinTone = 'selected' | 'unselected' | 'invited';
export interface PinStyle {
  fill: string;
  stroke: string;
  strokeWeight: number;
  sizePx: number;
  outline?: boolean;
}
export interface PinSpec {
  workerId: string;
  workerName: string;
  lat: number;
  lng: number;
  distanceKm: number;
  tone: PinTone;
  style: PinStyle;
}

const SIZE_CURRENT = 18;
const SIZE_INNER = 12;
const SIZE_EMPHASIZED = 24;

function pinStyle(tone: PinTone, sizePx: number, emphasized: boolean): PinStyle {
  const base =
    tone === 'invited'
      ? { fill: COLOR.white, stroke: COLOR.invitedBorder }
      : tone === 'selected'
        ? { fill: COLOR.brand, stroke: COLOR.white }
        : { fill: COLOR.navy, stroke: COLOR.white };
  return {
    ...base,
    strokeWeight: 2,
    sizePx: emphasized ? SIZE_EMPHASIZED : sizePx,
    ...(emphasized ? { outline: true } : {}),
  };
}

/**
 * Pinos do passo. Vacante: os do passo (visíveis, localizados, ≤ 50 km), 18 px. Distância: todo o
 * resultado visível até `band.max` — da banda atual 18 px (rosa se elegido, navy se não), de bandas
 * internas 12 px (navy); já convidado = branco; enfatizado = 24 px + outline.
 */
export function stepPins(ctx: BoardContext, step: StepId): PinSpec[] {
  const selected = new Set(selectedIds(ctx, step));
  const make = (c: SavedCandidate, inner: boolean): PinSpec => {
    const tone: PinTone = isInvited(c) ? 'invited' : !inner && selected.has(c.workerId) ? 'selected' : 'unselected';
    return {
      workerId: c.workerId,
      workerName: c.workerName,
      lat: c.lat as number,
      lng: c.lng as number,
      distanceKm: c.distanceKm as number,
      tone,
      style: pinStyle(tone, inner ? SIZE_INNER : SIZE_CURRENT, ctx.emphasizedId === c.workerId),
    };
  };
  if (step === 'vacante') {
    return stepCandidates(ctx, step)
      .filter((c) => hasLocation(c) && (c.distanceKm as number) <= MAX_RADIUS_KM)
      .map((c) => make(c, false));
  }
  const band = bandOfStep(step);
  return matchResult(ctx.candidates, ctx.currentIds)
    .filter((c) => isVisible(c, ctx.docOnly) && hasLocation(c) && (c.distanceKm as number) <= band.max)
    .map((c) => make(c, !inBand(c.distanceKm, band)));
}

export interface VacanteNote {
  /** visíveis > 50 km (fora do mapa) */
  farCount: number;
  /** visíveis sem ubicación */
  noLocationCount: number;
}

/** Nota amarela do passo vacante; `null` nos outros passos ou sem linhas. */
export function vacanteNote(ctx: BoardContext, step: StepId): VacanteNote | null {
  if (step !== 'vacante') return null;
  const rows = stepCandidates(ctx, step);
  if (rows.length === 0) return null;
  return {
    farCount: rows.filter((c) => hasLocation(c) && (c.distanceKm as number) > MAX_RADIUS_KM).length,
    noLocationCount: rows.filter((c) => !hasLocation(c)).length,
  };
}

