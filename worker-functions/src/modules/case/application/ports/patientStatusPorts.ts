/**
 * Ports do escritor de estado do paciente e do foguete (estado-automatico-do-paciente, D7 / design §5).
 * Só TIPOS: o use case depende destas interfaces; os adapters Pg moram em `infrastructure/` e a
 * composição em `interfaces/composition/patientStatusComposition.ts`. Nada aqui importa `pg`.
 */
import type { EscopoDaCompletude, PatientCompletenessCode } from '../../domain/PatientCompleteness';
import type { EntradaDerivacao } from '../../domain/derivarEstadoPaciente';
import type { PatientStatus } from '../../domain/enums/PatientStatus';
import type { AcaoTalentum } from '../../domain/talentumPausaDoPaciente';
import type { RecruitmentContext } from '../recruitmentReadinessContext';
import type { AuditActorType } from '@shared/audit/types';

/** Cliente da transação, no formato mínimo que o escritor e o foguete usam (um `PoolClient` o satisfaz). */
export interface StatusTx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Abre a transação com identidade do ator (RLS) — `withActorContext` no adapter. */
export interface TransactionRunnerPort {
  run<T>(fn: (tx: StatusTx) => Promise<T>): Promise<T>;
}

/** Códigos de completude que faltam, medidos no escopo pedido, DENTRO da transação de quem chama. */
export interface CompletenessReaderPort {
  missingFor(tx: StatusTx, patientId: string, escopo: EscopoDaCompletude): Promise<PatientCompletenessCode[]>;
}

/** Quantas alocações VIVAS o paciente tem no itinerário (D489/D530). Só a contagem — nunca nome de prestador. */
export interface LiveAllocationPort {
  countLive(tx: StatusTx, patientId: string): Promise<number>;
}

/**
 * P6 (semaforo-da-vaga F4): marca `talentum_pause_state` = PENDING_PAUSE / PENDING_RESUME nas vagas publicadas do paciente, DENTRO
 * da transação do escritor, e devolve os ids marcados. O envio ao Talentum é depois do COMMIT, de quem chama o escritor.
 */
export interface TalentumPauseMarkerPort {
  mark(tx: StatusTx, patientId: string, acao: AcaoTalentum): Promise<string[]>;
  /** I1: a vaga recém-lançada (publish) cujo paciente JÁ está pausado nasce PENDING_PAUSE, na transação do publish. Devolve o id marcado (ou `[]`). */
  markVacancyIfPatientPaused(tx: StatusTx, vacancyId: string): Promise<string[]>;
}

export interface PatientStatusPorts {
  transaction: TransactionRunnerPort;
  completeness: CompletenessReaderPort;
  allocation: LiveAllocationPort;
  talentum: TalentumPauseMarkerPort;
}

// ── foguete (ActivateRecruitmentUseCase) ─────────────────────────────────────

/** Trava paciente e serviço e lê o contexto do portão de recrutamento (SQL no adapter). */
export interface RecruitmentContextPort {
  lock(tx: StatusTx, patientId: string, serviceId: string): Promise<RecruitmentContext>;
}

/** Vaga do paciente como a trava do vínculo a enxerga. */
export interface LinkableVacancyRow {
  id: string;
  contractedServiceId: string | null;
  status: string | null;
}

export interface VacancyLinkPort {
  listPatientVacanciesForLink(tx: StatusTx, patientId: string): Promise<LinkableVacancyRow[]>;
}

/** Autor da ação na trilha da vaga (mesmo formato do `HumanActor` da vaga; declarado aqui para o use case não importar `interfaces/`). */
export interface RecruitmentActor {
  actorUserId: string | null;
  actorType: AuditActorType;
  actorLabel: string;
  traceId?: string | null;
}

export interface VacancyAuditPort {
  vacancyCreated(tx: StatusTx, vacancyId: string, row: Record<string, unknown>, actor: RecruitmentActor): Promise<void>;
  linkableDeclined(tx: StatusTx, vacancyId: string, declinedIds: readonly string[], actor: RecruitmentActor): Promise<void>;
}

// ── ações dos estados humanos (F3: PatientStatusActionUseCase / ListPatientStatusActionsUseCase) ──────────

/** As horas do itinerário do paciente (a entrada da regra pura), lidas DENTRO da transação de quem chama. `null` = paciente inexistente. */
export interface HorasDoItinerarioPort {
  load(tx: StatusTx, patientId: string, now: Date): Promise<EntradaDerivacao | null>;
}

/** O catálogo de transições (`patient_status_transitions`): para onde a FSM deixa sair de `from`. */
export interface TransitionCatalogPort {
  destinosDe(tx: StatusTx, from: PatientStatus | null): Promise<readonly PatientStatus[]>;
}
