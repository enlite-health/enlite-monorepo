/**
 * src/modules/anacare-hours/domain/AnaCareShift.ts
 *
 * Tipos do domínio "conferência de horas do Ana Care" (spec `anacare-conferencia-de-horas`, fase 1).
 * Espelham EXATAMENTE o contrato do protótipo aprovado
 * (`repos/infra/_worktrees/proto-anacare-horas/enlite-frontend/.../AnaCareHours/types.ts`) — a
 * spec §Contrato de dados exige que o backend real cumpra a mesma interface sem mudar hooks,
 * containers ou páginas do front.
 *
 * `id`/`anaCareShiftId` são o MESMO valor nesta fase (`source_shift_id`): o retrato `anacare_shift`
 * nasce vazio na migration 437 (job real é fase 2/4, sob PARE do lex/D344) — não existe `bigserial`
 * técnico a expor ainda. Documentado em DIVERGÊNCIAS no fecho da fase.
 */

/** ↔ `shift_hours_validation.approved_checkin_source` / `anacare_shift.checkin_source`. */
export type CheckInOrigin = 'sin_checkin' | 'web_admin' | 'app';

/** ↔ `shift_hours_validation.status` (CHECK 'pendente'|'validado'|'contestado'). */
export type ValidationStatus = 'pendiente' | 'validado' | 'contestado';

/** ↔ `shift_hours_validation.reason` (CHECK, lista fechada — D344). */
export const CONTEST_REASONS = ['no_asistio', 'horario_distinto', 'horas_mal_cargadas', 'otro'] as const;
export type ContestReason = (typeof CONTEST_REASONS)[number];

export function isContestReason(value: unknown): value is ContestReason {
  return typeof value === 'string' && (CONTEST_REASONS as readonly string[]).includes(value);
}

/** Limite de caracteres da nota de contestação — validado no modal E no backend (D344). */
export const CONTEST_NOTE_MAX_LENGTH = 500;

/** ↔ `shift_hours_validation.validated_by` (FK) resolvido para exibição. */
export interface Validator {
  id: string;
  name: string;
}

export interface AnaCareShift {
  /** Nesta fase = `anaCareShiftId` (ver cabeçalho do arquivo). */
  id: string;
  /** YYYY-MM-DD — ↔ `anacare_shift.period_month` truncado ao dia. */
  date: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** null = sem check-in registrado (origin sempre 'sin_checkin' nesse caso). */
  actualStart: string | null;
  actualEnd: string | null;
  /** null quando não há check-in real (D344: soma 0h no total, nunca fica ausente/omitido). */
  hoursActual: number | null;
  hoursScheduled: number;
  origin: CheckInOrigin;
  status: ValidationStatus;
  validatedBy?: Validator;
  validatedAt?: string;
  contestReason?: ContestReason;
  /** Texto da nota — SÓ presente quando quem lê tem a célula clínica (D344/D345: backlog o teste,
   * mas o contrato já reserva o campo opcional; quem não tem a célula recebe `undefined`). */
  contestNote?: string;
  anaCareShiftId: string;
}

export interface AnaCareProvider {
  anaCareId: string;
  linked: boolean;
  name?: string;
  shifts: AnaCareShift[];
}

export interface AnaCarePatient {
  anaCareId: string;
  linked: boolean;
  name?: string;
  providers: AnaCareProvider[];
}

export interface AnaCareOriginCounts {
  sinCheckin: number;
  webAdmin: number;
  app: number;
}

/**
 * Item 3 (revisão de PR): distingue as 3 razões por trás de `stale=true` até a TELA — antes,
 * `nao_construido` (retrato NUNCA sincronizado, `freshness.shifts===0`) e `velho` (sync rodou, mas
 * `getRetratoStatus().stale` da fonte voltou true, ex.: > 24h) colapsavam no mesmo booleano, e a
 * tela sempre mostrava "há mais de 24 horas" mesmo quando o sync nunca tinha rodado — mensagem
 * falsa. `stale` continua existindo (compat: `nao_construido || velho`).
 */
export type AnaCareSnapshotState = 'nao_construido' | 'velho' | 'fresco';

export interface AnaCareMonthSnapshot {
  /** YYYY-MM */
  month: string;
  updatedAt: string;
  stale: boolean;
  /** Ver `AnaCareSnapshotState` — distinção que `stale` sozinho não carrega (item 3). */
  snapshotState: AnaCareSnapshotState;
  circuitBreakerOpen: boolean;
  patients: AnaCarePatient[];
}

export interface AnaCareRetratoStatus {
  updatedAt: string;
  stale: boolean;
  circuitBreakerOpen: boolean;
}

// ── Comandos ─────────────────────────────────────────────────────────────
export interface ValidateShiftCommand {
  shiftId: string;
  validator: Validator;
}

export interface ValidateBatchCommand {
  shiftIds: string[];
  validator: Validator;
}

export interface ContestShiftCommand {
  shiftId: string;
  reason: ContestReason;
  note?: string;
  validator: Validator;
}

/** Erros de negócio — mesmos códigos do `AnaCareHoursServiceError` do protótipo. */
export type AnaCareHoursErrorCode = 'RETRATO_DESATUALIZADO' | 'JA_VALIDADO' | 'NOTA_MUITO_LONGA' | 'TURNO_NAO_ENCONTRADO';

export class AnaCareHoursServiceError extends Error {
  constructor(readonly code: AnaCareHoursErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AnaCareHoursServiceError';
  }
}

/** Máximo de turnos por chamada de validação em lote (spec F1: "limite máximo razoável"). */
export const VALIDATE_BATCH_MAX_SHIFTS = 200;
