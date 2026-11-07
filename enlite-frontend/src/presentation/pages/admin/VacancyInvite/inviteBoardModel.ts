/**
 * inviteBoardModel — regra da página "Invitar prestadores" (spec 089 §9.5), PURA.
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
import { OPERATION_TIME_ZONE } from '../../../utils/dateTimeFormat';

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

const COLOR = {
  brand: '#F227AF',
  navy: '#180149',
  white: '#ffffff',
  invitedBorder: '#737373',
} as const;

export interface BoardContext {
  candidates: readonly SavedCandidate[];
  /** ids do POST desta abertura (resultado do match). */
  currentIds: ReadonlySet<string>;
  docOnly: boolean;
  /** ids que a pessoa desmarcou (inclui os escondidos pelo interruptor ao ligar, DF-17). */
  unselected: ReadonlySet<string>;
  /** quantos saíram em cada passo NESTA visita (chave = String(step)). */
  sent?: Readonly<Record<string, number>>;
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

const bandOfStep = (step: DistanceStep): Band => BANDS[DISTANCE_STEPS.indexOf(step)];
const bandIndexOfStep = (step: DistanceStep): number => DISTANCE_STEPS.indexOf(step);

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
): SavedCandidate[] {
  return candidates.filter(
    (c) =>
      c.funnelStage === 'INVITED' &&
      c.messagedAt == null &&
      !c.replied &&
      !currentIds.has(c.workerId),
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
  if (step === 'vacante') return alreadyInVacancy(ctx.candidates, ctx.currentIds);
  const band = bandOfStep(step);
  return matchResult(ctx.candidates, ctx.currentIds).filter((c) => inBand(c.distanceKm, band));
}

/** Linhas visíveis do passo (interruptor aplicado). Ordem de entrada (o GET já ordena por distância). */
export function stepCandidates(ctx: BoardContext, step: StepId): SavedCandidate[] {
  return stepCandidatesUnfiltered(ctx, step).filter((c) => isVisible(c, ctx.docOnly));
}

const pendingOf = (rows: SavedCandidate[]) => rows.filter((c) => !isInvited(c));
const sentIn = (ctx: BoardContext, step: StepId) => ctx.sent?.[String(step)] ?? 0;

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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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
export function buildBoardView(ctx: BoardContext, step: StepId) {
  return {
    step,
    steps: stepSummaries(ctx, step),
    title: stepTitle(step),
    guide: stepGuide(ctx, step),
    /** ⚑7: "Solo aparecen prestadores que cumplen el perfil…" escondida no passo vacante. */
    showProfileNote: step !== 'vacante',
    docs: docsLine(ctx, step),
    selection: selectionSummary(ctx, step),
    rows: stepRowModels(ctx, step),
    rings: stepRings(ctx, step),
    fitRadiusKm: fitRadiusKmOf(step),
    pins: stepPins(ctx, step),
    vacanteNote: vacanteNote(ctx, step),
    footer: stepFooter(ctx, step),
  };
}

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
