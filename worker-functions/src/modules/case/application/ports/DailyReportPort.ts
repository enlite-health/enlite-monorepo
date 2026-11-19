/**
 * Porta do informe da guarda (spec 092, F2). O use case fala com ESTA interface; o adapter Postgres (`PgDailyReportRepository`) a
 * implementa dentro de UMA transação com o contexto do ator (`withActorContext`: conexão crua daria 500 em prd por RLS).
 *
 * A guarda do prestador vem da expansão do itinerário (DC-10, F-5): `guardsOf` reaproveita `readWorkerWindow`; nada de regra reescrita.
 */
import type { ProjectVersionInForce } from '../../domain/TherapeuticProjectVigencia';
import type { ActivityRow, ObjectiveRow, ReportContent, ScaleCatalog } from '../../domain/DailyReport';

/** Uma ocorrência (guarda) do prestador, já resolvida do `occurrenceId` virtual. */
export interface GuardOccurrence {
  occurrenceId: string;
  slotId: string;
  /** Serviço contratado da faixa (slot → serviço). */
  serviceId: string;
  /** Data civil `YYYY-MM-DD`. */
  onDate: string;
  endsAt: Date;
}

/** Versão do PTI com os ids que o molde precisa (lista plana, derivada do formato por diagnóstico — DD-8). */
export interface ProjectVersionRef extends ProjectVersionInForce {
  objectiveIds: readonly string[];
  activityIds: readonly string[];
}

export interface DailyReportTx {
  /** `workers.id` pelo uid do token; `null` = inexistente ou DISABLED. */
  workerIdByUid(uid: string): Promise<string | null>;
  guardsOf(workerId: string, today: string): Promise<GuardOccurrence[]>;
  scaleCatalog(): Promise<ScaleCatalog>;
  projectVersionsOfService(serviceId: string): Promise<ProjectVersionRef[]>;
  projectVersionById(id: string): Promise<ProjectVersionRef | null>;
  /** Linhas do catálogo na ORDEM dos ids pedidos; id desconhecido fica de fora. */
  catalogItems(objectiveIds: readonly string[], activityIds: readonly string[]): Promise<{ objectives: ObjectiveRow[]; activities: ActivityRow[] }>;
  reportById(id: string): Promise<ReportContent | null>;
  reportIdOfGuard(workerId: string, slotId: string, onDate: string): Promise<string | null>;
  /** Lança `DuplicateReportError` na corrida (UNIQUE da guarda ou do id). Nunca ecoa o conteúdo. */
  insertReport(id: string, content: ReportContent): Promise<void>;
}

export interface DailyReportPort {
  run<T>(work: (tx: DailyReportTx) => Promise<T>): Promise<T>;
}

/** Corrida de dois PUTs: o UNIQUE pegou o segundo. O use case relê e decide 200/409. */
export class DuplicateReportError extends Error {
  constructor() {
    super('duplicate_report');
    this.name = 'DuplicateReportError';
  }
}
