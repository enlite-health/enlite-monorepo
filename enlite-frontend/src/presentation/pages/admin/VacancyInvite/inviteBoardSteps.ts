import type { SavedCandidate } from '../../../../types/match';
import { isDocsComplete } from '../../../components/atoms/DocsStatusBadge';
import {
  ALL_STEPS, DISTANCE_STEPS, bandOfStep, bandIndexOfStep, isInvited, isStepCompleted, pendingOf, selectedIds, sentIn,
  stepCandidates, stepCandidatesUnfiltered, inviteBadge,
  type Band, type BoardContext, type DistanceStep, type InviteBadge, type StepId,
} from './inviteBoardCore';

// ---------------------------------------------------------------- cartões de passo

export type StepTone = 'done' | 'current' | 'pending-vacante' | 'idle';
export type StepSubKey = 'withoutWhatsapp' | 'toInvite' | 'invited';

export interface StepSummary {
  step: StepId;
  /** cartão "Ya en la vacante" só existe com gente (ou envio nesta visita). */
  visible: boolean;
  isCurrent: boolean;
  completed: boolean;
  tone: StepTone;
  total: number;
  pending: number;
  invited: number;
  sub: { key: StepSubKey; count: number };
  band: Band | null;
}

export function stepSummary(ctx: BoardContext, step: StepId, current: StepId): StepSummary {
  const rows = stepCandidates(ctx, step);
  const pending = pendingOf(rows).length;
  const invited = rows.length - pending;
  const sent = sentIn(ctx, step);
  const completed = sent > 0 || pending === 0;
  const isCurrent = step === current;
  const tone: StepTone = completed
    ? 'done'
    : isCurrent
      ? 'current'
      : step === 'vacante'
        ? 'pending-vacante'
        : 'idle';
  const shownInvited = Math.max(invited, sent);
  const sub =
    completed && shownInvited > 0
      ? { key: 'invited' as const, count: shownInvited }
      : { key: step === 'vacante' ? ('withoutWhatsapp' as const) : ('toInvite' as const), count: pending };
  return {
    step,
    visible: step !== 'vacante' || rows.length > 0 || sent > 0,
    isCurrent,
    completed,
    tone,
    total: rows.length,
    pending,
    invited,
    sub,
    band: step === 'vacante' ? null : bandOfStep(step),
  };
}

export const stepSummaries = (ctx: BoardContext, current: StepId): StepSummary[] =>
  ALL_STEPS.map((s) => stepSummary(ctx, s, current));

// ---------------------------------------------------------------- rodapé

export type FooterMode = 'invite' | 'empty' | 'after' | 'last';
export interface FooterModel {
  mode: FooterMode;
  selectedCount: number;
  pendingCount: number;
  /** "Buscar más lejos · hasta {km} km ({count} más)"; null no último passo. */
  more: { km: DistanceStep; count: number } | null;
}

/**
 * Modos: `invite` (≥1 elegido) · `empty` (pendentes, 0 elegidos) · `after` (concluído: Buscar más
 * lejos primário + Terminar) · `last` (concluído no passo 50: só Terminar primário). Em `invite`/
 * `empty` no passo 50 não há "Buscar más lejos" (`more = null`).
 */
export function stepFooter(ctx: BoardContext, step: StepId): FooterModel {
  const rows = stepCandidates(ctx, step);
  const pendingCount = pendingOf(rows).length;
  const selectedCount = selectedIds(ctx, step).length;
  const nextStep: DistanceStep | null =
    step === 'vacante' ? 5 : step === 50 ? null : DISTANCE_STEPS[bandIndexOfStep(step) + 1];
  const more = nextStep ? { km: nextStep, count: pendingOf(stepCandidates(ctx, nextStep)).length } : null;
  const completed = isStepCompleted(ctx, step);
  const mode: FooterMode = completed
    ? step === 50
      ? 'last'
      : 'after'
    : selectedCount >= 1
      ? 'invite'
      : 'empty';
  return { mode, selectedCount, pendingCount, more };
}

// ---------------------------------------------------------------- cabeçalho do bloco

export type TitleKind = 'vacante' | 'upTo' | 'between';
export type GuideKey =
  | 'vacantePending'
  | 'vacanteDone'
  | 'firstStep'
  | 'nextStep'
  | 'doneMore'
  | 'doneLast';

export function stepTitle(step: StepId): { kind: TitleKind; min: number; max: number } {
  if (step === 'vacante') return { kind: 'vacante', min: 0, max: 0 };
  const b = bandOfStep(step);
  return { kind: b.min === 0 ? 'upTo' : 'between', min: b.min, max: b.max };
}

export function stepGuide(ctx: BoardContext, step: StepId): GuideKey {
  const completed = isStepCompleted(ctx, step);
  if (step === 'vacante') return completed ? 'vacanteDone' : 'vacantePending';
  if (completed) return step === 50 ? 'doneLast' : 'doneMore';
  return step === 5 ? 'firstStep' : 'nextStep';
}

export interface DocsLine {
  /** 'off': "Completos: a · Faltan documentos: b"; 'on': "Completos: a · Ocultos por documentos: b". */
  mode: 'off' | 'on';
  complete: number;
  missing: number;
}

export function docsLine(ctx: BoardContext, step: StepId): DocsLine {
  const rows = stepCandidatesUnfiltered(ctx, step);
  const complete = rows.filter((c) => isDocsComplete(c.documentStatus)).length;
  return { mode: ctx.docOnly ? 'on' : 'off', complete, missing: rows.length - complete };
}

export interface SelectionSummary {
  selected: number;
  pending: number;
  /** pending = 0 → "Todos ya invitados" */
  allInvited: boolean;
  /** caixa "Todos" marcada */
  allChecked: boolean;
  /** caixa "Todos" desabilitada */
  allDisabled: boolean;
}

export function selectionSummary(ctx: BoardContext, step: StepId): SelectionSummary {
  const pending = pendingOf(stepCandidates(ctx, step)).length;
  const selected = selectedIds(ctx, step).length;
  return {
    selected,
    pending,
    allInvited: pending === 0,
    allChecked: pending > 0 && selected === pending,
    allDisabled: pending === 0,
  };
}

export interface RowModel {
  candidate: SavedCandidate;
  /** convidado = sem caixa. */
  invited: boolean;
  selectable: boolean;
  selected: boolean;
  docsComplete: boolean;
  badge: InviteBadge;
  /** distância "—" quando null */
  distanceKm: number | null;
}

export function stepRowModels(ctx: BoardContext, step: StepId): RowModel[] {
  const selected = new Set(selectedIds(ctx, step));
  return stepCandidates(ctx, step).map((c) => ({
    candidate: c,
    invited: isInvited(c),
    selectable: !isInvited(c),
    selected: selected.has(c.workerId),
    docsComplete: isDocsComplete(c.documentStatus),
    badge: inviteBadge(c, ctx.operationDate, ctx.timeZone),
    distanceKm: c.distanceKm,
  }));
}

/** Tudo que a página precisa decidir para um passo — a página só desenha. */
