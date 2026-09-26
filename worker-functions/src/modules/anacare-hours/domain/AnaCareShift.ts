/**
 * src/modules/anacare-hours/domain/AnaCareShift.ts
 *
 * Tipos do domínio "conferência de horas do Ana Care" (spec `anacare-conferencia-de-horas`, fase 1).
 * Espelham EXATAMENTE o contrato do protótipo aprovado
 * (`repos/infra/_worktrees/proto-anacare-horas/enlite-frontend/.../AnaCareHours/types.ts`) — a
 * spec §Contrato de dados exige que o backend real cumpra a mesma interface sem mudar hooks,
 * containers ou páginas do front.
 *
 * `id`/`anaCareShiftId` são o MESMO valor nesta fase (`source_shift_id`) — não existe `bigserial`
 * técnico a expor. Documentado em DIVERGÊNCIAS no fecho da fase.
 */

/** ↔ `shift_hours_validation.approved_checkin_source` / origem do check-in do turno na fonte. */
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
  /** YYYY-MM-DD — dia do turno, dentro do `period_month` do retrato agregado. */
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
  /**
   * Lançamento no Axonico para este dia (change `axonico-envio-rastreavel`, 24/09/2026, migration
   * 473) — casado por `service_date` (`AnaCareHoursService.getPatientMonth`, via
   * `IAxonicoLancamentoRepository.findSentByDocumentAndMonth`). Ausente = nunca lançado NESTE mês
   * (ou o paciente não tem `documentNumber`, caso em que `getPatientMonth` nem consulta). Só
   * `status: 'enviado'` é modelado aqui — `duplicado`/`erro` são tentativas, não um estado do dia.
   */
  axonico?: {
    status: 'enviado';
    numeroComprobante: string;
    codAutorizacion: string;
    sentAt: string;
    /** Ausente só para tentativas gravadas antes da migration 473 (sem autor conhecido). */
    sentBy?: {
      uid: string;
      /** `null` quando `users.display_name` está vazio para este uid — nunca `undefined` (o campo em si está presente). */
      displayName: string | null;
    };
  };
}

export interface AnaCareProvider {
  anaCareId: string;
  linked: boolean;
  name?: string;
  shifts: AnaCareShift[];
}

/** Usado só pelo DETALHE (`getPatientMonth`, ao vivo na fonte) — por turno. Ver `AnaCareListPatient` para a LISTA (F6.2, agregado). */
export interface AnaCarePatient {
  anaCareId: string;
  linked: boolean;
  name?: string;
  /**
   * Documento de identidade do paciente (categoria/valor, ex. "DNI"/"30111222") — vem do payload
   * do turno na fonte, mesmo desenho do `name` (item 1). PII: ausente (não vazio, não redigido) a
   * menos que o ator tenha `patient_identity:read` — mesmo gate do container "Identidade" da ficha
   * do paciente (`patientContainerAccess.ts`), aplicado em `AnaCareHoursController.
   * canReadPatientDocument`. Só o DETALHE carrega — a LISTA (`AnaCareListPatient`) nunca ganha
   * este campo.
   */
  documentType?: string;
  documentNumber?: string;
  providers: AnaCareProvider[];
}

/**
 * Contrato da LISTA (F6.2, D361 Adendo 17/09) — sem NENHUM turno individual, lido do agregado
 * (`anacare_patient_month` + `anacare_patient_month_provider`, migrations 441/442). `providers`
 * continua array (não só um número) para o filtro "Todos los prestadores" do front seguir
 * funcionando sem reescrita — só `provider.shifts` some.
 */
export interface AnaCareListProvider {
  anaCareId: string;
  linked: boolean;
  name?: string;
}

export interface AnaCareListPatient {
  anaCareId: string;
  name?: string;
  /** D349 item 2 — paciente permanece SEMPRE sem vínculo, bloqueado. */
  linked: false;
  providers: AnaCareListProvider[];
  providersCount: number;
  shiftsCount: number;
  /** Modo `zero` de `totalHours` (front) — soma sozinha. */
  hoursActualSum: number;
  /** Somado a `hoursActualSum` cobre o modo previsto — nunca isolado, nunca somado ao modo `zero`. */
  hoursScheduledSumMissingActual: number;
  /** `COUNT` por status em `shift_hours_validation` (GROUP BY) — nunca mais o join 1:1 por turno. */
  validated: number;
  contested: number;
  originSinCheckin: number;
  originWebAdmin: number;
  originApp: number;
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
 *
 * F2 (change `anacare-horas-conclusao-de-corrida`, migration 457) — 2 estados NOVOS, derivados da
 * CONCLUSÃO da corrida de sync (`anacare_sync_run.status`/`reservations_total`/`reservations_done`),
 * nunca calculados no frontend (ver `AnaCareHoursMapper.computeSnapshotState`):
 *   - `desconhecido` — `status IS NULL`. É o estado das linhas de agosto/setembro pré-existentes
 *     (sync rodou antes desta change existir, nunca gravou conclusão) — dizer `parcial` sobre elas
 *     seria uma afirmação que o sistema não tem base para fazer (não tem cursor/contagem
 *     registrados, só ausência de dado). NUNCA confundir com `parcial`.
 *   - `parcial` — `status IN ('running','failed')`, ou `status='done'` com
 *     `reservations_done < reservations_total`: a corrida NÃO terminou (aba fechada no meio, ou o
 *     runner falhou) e o mês pode ter reservas não visitadas.
 * Precedência fechada (proposal.md §Decisão fechada): `nao_construido → desconhecido → parcial →
 * velho → fresco`, cada um só avaliado depois que os anteriores foram descartados.
 */
export type AnaCareSnapshotState = 'nao_construido' | 'desconhecido' | 'parcial' | 'velho' | 'fresco';

export interface AnaCareMonthSnapshot {
  /** YYYY-MM */
  month: string;
  updatedAt: string;
  stale: boolean;
  /** Ver `AnaCareSnapshotState` — distinção que `stale` sozinho não carrega (item 3). */
  snapshotState: AnaCareSnapshotState;
  circuitBreakerOpen: boolean;
  /** F6.2: pacientes AGREGADOS (sem turno individual) — ver `AnaCareListPatient`. */
  patients: AnaCareListPatient[];
  /**
   * F2 (migration 457) — só presentes quando `snapshotState==='parcial'` E o sync gravou as
   * contagens (nunca fingidas em `0`): "quanto foi percorrido" para a mensagem do banner. Ausentes
   * (`undefined`) em qualquer outro estado, ou quando `parcial` nasceu de `running`/`failed` sem
   * contagem gravada ainda — DIVERGÊNCIA do design.md (que deixava a decisão de expor esses 2
   * campos na resposta HTTP "fora desta mudança de contrato, avaliar ao implementar"): o prompt
   * desta fase pede explicitamente o texto "processadas X de Y" na tela, e isso exige os números
   * no wire — reportado no fecho da task.
   */
  reservationsTotal?: number;
  reservationsDone?: number;
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
