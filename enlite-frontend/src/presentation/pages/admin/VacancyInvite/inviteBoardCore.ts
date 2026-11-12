/**
 * inviteBoardCore — base da regra da página "Invitar prestadores" (spec 089 §9.5), PURA.
 *
 * Sem React, sem i18n: devolve chaves, números e estilos; a página só desenha. Entrada = o GET
 * `match-results` + `currentIds` (ids do POST desta abertura) + estado de tela (interruptor, passo,
 * desmarcados, envios desta visita).
 *
 * Donos reusados (não reescritos): "documentos completos" = `isDocsComplete` (DocsStatusBadge,
 * DF-16); fuso de dia = `OPERATION_TIME_ZONE` (dateTimeFormat) / `COUNTRY_TIME_ZONE`
 * (countryTimeZone) — a página passa `timeZone`; `operationDate` vem do servidor (nunca o relógio
 * do navegador).
 */
import type { SavedCandidate } from '../../../../types/match';
import { isDocsComplete } from '../../../components/atoms/DocsStatusBadge';
import { OPERATION_TIME_ZONE, formatInstant } from '../../../utils/dateTimeFormat';

export type DistanceStep = 5 | 10 | 20 | 50;
export type StepId = 'vacante' | DistanceStep;

export interface Band {
  min: number;
  max: DistanceStep;
}

/** Pertença `(min, max]`. */
export const BANDS: readonly Band[] = [
  { min: 0, max: 5 },
  { min: 5, max: 10 },
  { min: 10, max: 20 },
  { min: 20, max: 50 },
];
export const DISTANCE_STEPS: readonly DistanceStep[] = [5, 10, 20, 50];
export const ALL_STEPS: readonly StepId[] = ['vacante', 5, 10, 20, 50];
export const MAX_RADIUS_KM = 50;

export interface BoardContext {
  candidates: readonly SavedCandidate[];
  /** ids do POST desta abertura (resultado do match). */
  currentIds: ReadonlySet<string>;
  docOnly: boolean;
  /** ids que a pessoa desmarcou (inclui os escondidos pelo interruptor ao ligar, DF-17). */
  unselected: ReadonlySet<string>;
  /** quantos saíram em cada passo NESTA visita (chave = String(step)). */
  sent?: Readonly<Record<string, number>>;
  /** ids que saíram do passo "Ya en la vacante" NESTA visita: ficam na lista como "Invitado hoy" (F4/RF-14). */
  sentVacante?: ReadonlySet<string>;
  /** `operationDate` do servidor ('YYYY-MM-DD'). */
  operationDate?: string;
  /** IANA do país da vacante; default = fuso do operador (Buenos Aires). */
  timeZone?: string;
  /** pino em hover/foco (24 px + outline). */
  emphasizedId?: string | null;
}

// ---------------------------------------------------------------- predicados básicos

export const isInvited = (c: SavedCandidate): boolean => c.messagedAt != null;
export const hasLocation = (c: SavedCandidate): boolean =>
  c.distanceKm != null && c.lat != null && c.lng != null;
export const isVisible = (c: SavedCandidate, docOnly: boolean): boolean =>
  !docOnly || isDocsComplete(c.documentStatus);

/** `(min, max]`; a banda 0–5 aceita também d = 0 (colado no serviço). Sem distância = fora. */
export function inBand(d: number | null, band: Band): boolean {
  if (d == null) return false;
  const aboveMin = d > band.min || (band.min === 0 && d === 0);
  return aboveMin && d <= band.max;
}

export function bandIndexOf(d: number | null): number | null {
  const i = BANDS.findIndex((b) => inBand(d, b));
  return i === -1 ? null : i;
}

export const bandOfStep = (step: DistanceStep): Band => BANDS[DISTANCE_STEPS.indexOf(step)];
export const bandIndexOfStep = (step: DistanceStep): number => DISTANCE_STEPS.indexOf(step);

/** Resultado do match = candidatos cujo `workerId ∈ currentIds`. */
export function matchResult(
  candidates: readonly SavedCandidate[],
  currentIds: ReadonlySet<string>,
): SavedCandidate[] {
  return candidates.filter((c) => currentIds.has(c.workerId));
}

/** "Ya en la vacante" (⚑4): INVITED, sem WhatsApp, sem resposta, FORA do resultado atual. Inclui sem localização. */
export function alreadyInVacancy(
  candidates: readonly SavedCandidate[],
  currentIds: ReadonlySet<string>,
  /** enviados deste passo nesta visita: continuam listados (já convidados, sem caixa). */
  keepSent?: ReadonlySet<string>,
): SavedCandidate[] {
  return candidates.filter(
    (c) =>
      !currentIds.has(c.workerId) &&
      ((keepSent?.has(c.workerId) ?? false) ||
        (c.funnelStage === 'INVITED' && c.messagedAt == null && !c.replied)),
  );
}

// ---------------------------------------------------------------- passo

export function parseStep(raw: string | null | undefined): StepId | null {
  if (raw === 'vacante') return 'vacante';
  if (raw === '5' || raw === '10' || raw === '20' || raw === '50') return Number(raw) as DistanceStep;
  return null;
}

/** Passo de abertura: `?paso=` válido vence; senão vacante (se há visíveis) ou 5. */
export function openingStep(
  ctx: Pick<BoardContext, 'candidates' | 'currentIds' | 'docOnly'>,
  paso?: string | null,
): StepId {
  const fromUrl = parseStep(paso);
  if (fromUrl) return fromUrl;
  const visible = alreadyInVacancy(ctx.candidates, ctx.currentIds).filter((c) =>
    isVisible(c, ctx.docOnly),
  );
  return visible.length > 0 ? 'vacante' : 5;
}

// ---------------------------------------------------------------- linhas do passo

/** Linhas do passo ANTES do interruptor (para contar completos × faltan). */
export function stepCandidatesUnfiltered(ctx: BoardContext, step: StepId): SavedCandidate[] {
  if (step === 'vacante') return alreadyInVacancy(ctx.candidates, ctx.currentIds, ctx.sentVacante);
  const band = bandOfStep(step);
  return matchResult(ctx.candidates, ctx.currentIds).filter((c) => inBand(c.distanceKm, band));
}

/** Linhas visíveis do passo (interruptor aplicado). Ordem de entrada (o GET já ordena por distância). */
export function stepCandidates(ctx: BoardContext, step: StepId): SavedCandidate[] {
  return stepCandidatesUnfiltered(ctx, step).filter((c) => isVisible(c, ctx.docOnly));
}

export const pendingOf = (rows: SavedCandidate[]) => rows.filter((c) => !isInvited(c));
export const sentIn = (ctx: BoardContext, step: StepId) => ctx.sent?.[String(step)] ?? 0;

/** Concluído (✓) ⇔ houve envio no passo nesta visita OU 0 pendentes visíveis. */
export function isStepCompleted(ctx: BoardContext, step: StepId): boolean {
  return sentIn(ctx, step) > 0 || pendingOf(stepCandidates(ctx, step)).length === 0;
}

// ---------------------------------------------------------------- seleção

/** Pré-seleção: pendentes visíveis do passo menos os desmarcados. Já convidado nunca entra. */
export function selectedIds(ctx: BoardContext, step: StepId): string[] {
  return pendingOf(stepCandidates(ctx, step))
    .filter((c) => !ctx.unselected.has(c.workerId))
    .map((c) => c.workerId);
}

export function toggleOne(unselected: ReadonlySet<string>, workerId: string): Set<string> {
  const next = new Set(unselected);
  if (next.has(workerId)) next.delete(workerId);
  else next.add(workerId);
  return next;
}

/** Caixa "Todos": marca/desmarca todos os pendentes visíveis do passo. */
export function setAllSelected(ctx: BoardContext, step: StepId, select: boolean): Set<string> {
  const next = new Set(ctx.unselected);
  for (const c of pendingOf(stepCandidates(ctx, step))) {
    if (select) next.delete(c.workerId);
    else next.add(c.workerId);
  }
  return next;
}

/**
 * Interruptor "Solo con documentos completos" (DF-17). Ligar: esconde e DESMARCA os "Faltan
 * documentos" (entram em `unselected`). Desligar: não mexe em `unselected` — voltam desmarcados.
 */
export function applyDocOnly(
  turnOn: boolean,
  unselected: ReadonlySet<string>,
  candidates: readonly SavedCandidate[],
): { docOnly: boolean; unselected: Set<string> } {
  const next = new Set(unselected);
  if (turnOn) {
    for (const c of candidates) if (!isDocsComplete(c.documentStatus)) next.add(c.workerId);
  }
  return { docOnly: turnOn, unselected: next };
}

// ---------------------------------------------------------------- dia / fuso

/** Dia civil ('YYYY-MM-DD') de um INSTANTE no fuso IANA explícito (nunca o do navegador). */
export function dayInZone(iso: string, timeZone: string = OPERATION_TIME_ZONE): string | null {
  return formatInstant(iso, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA', timeZone);
}

/** 'YYYY-MM-DD' → 'dd/MM'. */
export const dayMonthOf = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

export type InviteBadge = { kind: 'today' } | { kind: 'on'; dayMonth: string } | null;

/** Selo "Invitado hoy" / "Invitado el dd/MM" (DF-5); `null` se não recebeu. */
export function inviteBadge(
  c: SavedCandidate,
  operationDate: string | undefined,
  timeZone?: string,
): InviteBadge {
  if (!c.messagedAt) return null;
  const day = dayInZone(c.messagedAt, timeZone);
  if (!day) return null;
  if (operationDate && day === operationDate) return { kind: 'today' };
  return { kind: 'on', dayMonth: dayMonthOf(day) };
}

