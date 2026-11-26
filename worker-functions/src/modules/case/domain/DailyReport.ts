/**
 * Informe da guarda (spec 092, F2) — o domínio: escalas, resposta (`ScaleAnswer`, sealed), prazo (`ReportDue`, DC-2), molde
 * (`DailyReportTemplate`, DC-4/DC-8) e a validação do envio contra o molde (contrato HTTP do design).
 *
 * Regras que moram SÓ aqui (um dono):
 *   DC-2  prazo = fim da guarda + 24 h; o servidor ainda aceita até +7 dias; o atraso é DERIVADO (nunca gravado).
 *   DC-4  sem PTI vigente → molde vazio (só relatório); objetivo sem pergunta (legado) NÃO é perguntado; atividade sem escala vira `SN`.
 *   L3    escala `MULTI_CHOICE` (OM) fica fora da V1: objetivo e atividade OM não entram no molde.
 *   DC-8  objetivos obrigatórios, atividades opcionais (linha ausente = "não registrada").
 *   DC-6  a nota NÃO é copiada: o catálogo a devolve por opção; a resposta guarda só (escala, opção).
 *
 * Privacidade: NENHUM erro deste arquivo carrega `narrative` nem resposta — só código da regra. Menos IFs: as regras por tipo de resposta
 * moram numa tabela (`ANSWER_RULES`), não numa cadeia de `if`.
 */

// ── Catálogo de escalas (o que o app e a validação leem) ───────────────────────────────────────────────────────────────

export type AnswerKind = 'SINGLE_CHOICE' | 'COUNT' | 'MULTI_CHOICE';

export interface ScaleOption {
  code: string;
  position: number;
  label: string;
  meaning: string;
  /** `null` = a planilha não define nota para a opção (lacuna L1) — nunca inventada. */
  score: number | null;
  alert: { kind: string; text: string } | null;
  asksReason: boolean;
}

export interface ScaleReason {
  code: string;
  position: number;
  label: string;
}

export interface Scale {
  code: string;
  name: string;
  answeredBy: 'AT' | 'CAREGIVER';
  answerKind: AnswerKind;
  options: ScaleOption[];
  reasons: ScaleReason[];
}

export type ScaleCatalog = ReadonlyMap<string, Scale>;

/** Escala do checklist de atividade sem escala no catálogo (DC-4): Sí/No — binário, não é escala clínica. */
export const FALLBACK_ACTIVITY_SCALE = 'SN';

// ── Resposta (sealed) ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ScaleAnswer =
  | { readonly kind: 'choice'; readonly optionCode: string; readonly reasonCode: string | null }
  | { readonly kind: 'count'; readonly value: number };

export interface ReportAnswer {
  readonly itemKind: 'objective' | 'activity';
  readonly itemId: string;
  readonly scaleCode: string;
  readonly answer: ScaleAnswer;
}

// ── Erros nomeados (422 do contrato; o corpo NUNCA ecoa narrativa/respostas) ───────────────────────────────────────────

export const DAILY_REPORT_ERROR_CODES = [
  'occurrence_unknown',
  'daily_report_window_closed',
  'pti_version_mismatch',
  'item_not_in_pti',
  'scale_mismatch',
  'option_unknown',
  'reason_required',
  'reason_not_allowed',
  'objective_answer_missing',
] as const;
export type DailyReportErrorCode = (typeof DAILY_REPORT_ERROR_CODES)[number];

export class DailyReportError extends Error {
  constructor(readonly code: DailyReportErrorCode) {
    super(code); // a mensagem é o código: nada de texto clínico, nem por engano
    this.name = 'DailyReportError';
  }
}

/**
 * 409 do contrato: `daily_report_conflict` (mesmo id, corpo diferente) e `daily_report_exists` (outro id para a guarda); emenda 077:
 * `daily_report_presence_open` (guarda sem saída aceita/declarada) e `daily_report_template_outdated` (molde ≠ PTI vigente) — os dois retentáveis.
 */
export type DailyReportConflictCode = 'daily_report_conflict' | 'daily_report_exists' | 'daily_report_presence_open' | 'daily_report_template_outdated';

export class DailyReportConflictError extends Error {
  constructor(readonly code: DailyReportConflictCode) {
    super(code);
    this.name = 'DailyReportConflictError';
  }
}

// ── Prazo (DC-2) ───────────────────────────────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
export const DUE_AFTER_GUARD_HOURS = 24;
export const ACCEPT_AFTER_DUE_DAYS = 7;

export class ReportDue {
  private constructor(readonly dueAt: Date) {}

  /** `guardEndsAt` = fim programado da guarda (instante). */
  static of(guardEndsAt: Date): ReportDue {
    return new ReportDue(new Date(guardEndsAt.getTime() + DUE_AFTER_GUARD_HOURS * HOUR_MS));
  }

  /** Último instante em que o servidor ainda aceita o informe (prazo + 7 dias). */
  get acceptUntil(): Date {
    return new Date(this.dueAt.getTime() + ACCEPT_AFTER_DUE_DAYS * 24 * HOUR_MS);
  }

  /** Fora da janela de aceite → 422 `daily_report_window_closed`. */
  isWindowClosed(now: Date): boolean {
    return now.getTime() > this.acceptUntil.getTime();
  }

  /** Atraso DERIVADO: enviado depois do prazo. Nunca é coluna. */
  isLate(deviceSubmittedAt: Date): boolean {
    return deviceSubmittedAt.getTime() > this.dueAt.getTime();
  }
}

// ── Molde (DC-4, DC-8, L3) ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ObjectiveRow {
  id: string;
  title: string;
  question: string | null;
  scaleCode: string | null;
}

export interface ActivityRow {
  id: string;
  title: string;
  description: string | null;
  scaleCode: string | null;
  frequency: string | null;
}

export interface TemplateObjective {
  id: string;
  title: string;
  question: string;
  scaleCode: string;
}

export interface TemplateActivity {
  id: string;
  title: string;
  description: string | null;
  scaleCode: string;
  frequency: string | null;
}

/** Tipos de escala que a V1 pergunta: botões e contagem. `MULTI_CHOICE` (OM) fica fora (L3). */
const ASKABLE_KINDS: ReadonlySet<AnswerKind> = new Set<AnswerKind>(['SINGLE_CHOICE', 'COUNT']);

export class DailyReportTemplate {
  private constructor(
    readonly ptiVersionId: string | null,
    readonly objectives: readonly TemplateObjective[],
    readonly activities: readonly TemplateActivity[],
  ) {}

  /** DC-4: sem PTI vigente → só o relatório; nenhuma pergunta inventada. */
  static withoutProject(): DailyReportTemplate {
    return new DailyReportTemplate(null, [], []);
  }

  static build(
    ptiVersionId: string,
    objectives: readonly ObjectiveRow[],
    activities: readonly ActivityRow[],
    catalog: ScaleCatalog,
  ): DailyReportTemplate {
    const askable = (code: string): boolean => ASKABLE_KINDS.has(catalog.get(code)?.answerKind as AnswerKind);
    const objs: TemplateObjective[] = [];
    for (const o of objectives) {
      // objetivo legado/manual (sem pergunta) e OM ficam de fora (DC-4, L3)
      if (o.question !== null && o.scaleCode !== null && askable(o.scaleCode)) {
        objs.push({ id: o.id, title: o.title, question: o.question, scaleCode: o.scaleCode });
      }
    }
    const acts: TemplateActivity[] = [];
    for (const a of activities) {
      const scaleCode = a.scaleCode ?? FALLBACK_ACTIVITY_SCALE;
      if (askable(scaleCode)) acts.push({ id: a.id, title: a.title, description: a.description, scaleCode, frequency: a.frequency });
    }
    return new DailyReportTemplate(ptiVersionId, objs, acts);
  }

  private itemScale(kind: 'objective' | 'activity', id: string): string | null {
    const list: readonly { id: string; scaleCode: string }[] = kind === 'objective' ? this.objectives : this.activities;
    return list.find((i) => i.id === id)?.scaleCode ?? null;
  }

  /** Valida o envio contra o molde (design §Contrato). Lança `DailyReportError`; devolve nada. */
  validate(answers: readonly ReportAnswer[], catalog: ScaleCatalog): void {
    for (const a of answers) {
      const expected = this.itemScale(a.itemKind, a.itemId);
      if (expected === null) throw new DailyReportError('item_not_in_pti');
      if (a.scaleCode !== expected) throw new DailyReportError('scale_mismatch');
      const scale = catalog.get(expected);
      if (!scale) throw new DailyReportError('scale_mismatch');
      ANSWER_RULES[a.answer.kind](a.answer as never, scale);
    }
    const answered = new Set(answers.filter((a) => a.itemKind === 'objective').map((a) => a.itemId));
    if (this.objectives.some((o) => !answered.has(o.id))) throw new DailyReportError('objective_answer_missing');
  }
}

// ── Regras por tipo de resposta (tabela, não cadeia de if) ──────────────────────────────────────────────────────────

const ANSWER_RULES: {
  [K in ScaleAnswer['kind']]: (answer: Extract<ScaleAnswer, { kind: K }>, scale: Scale) => void;
} = {
  choice: (answer, scale) => {
    if (scale.answerKind !== 'SINGLE_CHOICE') throw new DailyReportError('scale_mismatch');
    const option = scale.options.find((o) => o.code === answer.optionCode);
    if (!option) throw new DailyReportError('option_unknown');
    if (option.asksReason && answer.reasonCode === null) throw new DailyReportError('reason_required');
    if (answer.reasonCode !== null && (!option.asksReason || !scale.reasons.some((r) => r.code === answer.reasonCode))) {
      throw new DailyReportError('reason_not_allowed');
    }
  },
  count: (answer, scale) => {
    if (scale.answerKind !== 'COUNT') throw new DailyReportError('scale_mismatch');
    if (!Number.isInteger(answer.value) || answer.value < 0 || answer.value > 999) throw new DailyReportError('option_unknown');
  },
};

// ── Idempotência: "mesmo corpo" (retry) × "corpo diferente" (conflito) ─────────────────────────────────────────────────

export interface ReportContent {
  workerId: string;
  slotId: string;
  onDate: string;
  ptiVersionId: string | null;
  narrative: string;
  narrativeSource: 'TYPED' | 'DICTATED' | 'MIXED';
  deviceSubmittedAt: Date;
  appVersion: string;
  answers: readonly ReportAnswer[];
}

const answerKey = (a: ReportAnswer): string =>
  `${a.itemKind}|${a.itemId}|${a.scaleCode}|${a.answer.kind === 'choice' ? `c:${a.answer.optionCode}:${a.answer.reasonCode ?? ''}` : `n:${a.answer.value}`}`;

/** Mesmo conteúdo (ordem das respostas não importa; instante comparado em ms). Pura. */
export function sameReportContent(a: ReportContent, b: ReportContent): boolean {
  const scalar =
    a.workerId === b.workerId && a.slotId === b.slotId && a.onDate === b.onDate && a.ptiVersionId === b.ptiVersionId &&
    a.narrative === b.narrative && a.narrativeSource === b.narrativeSource && a.appVersion === b.appVersion &&
    a.deviceSubmittedAt.getTime() === b.deviceSubmittedAt.getTime();
  if (!scalar || a.answers.length !== b.answers.length) return false;
  const keys = new Set(a.answers.map(answerKey));
  return b.answers.every((x) => keys.has(answerKey(x)));
}
