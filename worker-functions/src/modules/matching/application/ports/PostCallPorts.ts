import type { Pool, PoolClient } from 'pg';
import type { AdmissionEventInput } from './AdmissionMessagingPorts';

/**
 * Portos do job de fim de call (spec 052, Fase 3, T-34a): a lógica é UMA só (`AdmissionPostCallJob` + `AdmissionConferenceObserver`);
 * muda a FONTE (onde ficam as reuniões pendentes e seu estado) e o DESTINO (a trilha, o prefixo de log, os detectores).
 *
 *  - admissão: `AdmissionPostCallRepository` (fonte e detectores) e `AdmissionEventRepository` (trilha) — a conformidade é
 *    ESTRUTURAL e conferida pelo compilador em `__tests__/postCallPortsConformance.test.ts` (os repositórios não mudam uma linha);
 *  - enquadre: `EnquadrePostCallRepository` e `EnquadreEventTrailRepository`, sobre `enquadre_events`, SEM `JOIN` em paciente.
 */

export type Ex = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** A reunião/evento que o job trava e lê. `patient_is_test` e `rehearsal_until` são a entrada de `admissionRealm` (enquadre: `false`/`null`). */
export interface PostCallSubject {
  id: string;
  host_email: string;
  meet_link: string | null;
  meet_space_name: string | null;
  slot_start: Date;
  slot_end: Date;
  /** Início real já gravado (F14); `null` = nenhuma conferência observada ainda. */
  conference_started_at: Date | null;
  import_status: string | null;
  patient_is_test: boolean;
  rehearsal_until: Date | null;
}

/** FONTE: listar pendentes (com lote próprio de cada implementação), travar um a um e gravar o estado. */
export interface PostCallSource {
  listCandidateIds(now: Date, limit?: number, ex?: Ex): Promise<string[]>;
  /** `FOR UPDATE SKIP LOCKED`: quem não consegue a trava (outra execução com o mesmo registro) recebe `null` e segue adiante. */
  lockCandidate(id: string, now: Date, ex: Ex): Promise<PostCallSubject | null>;
  saveSpace(id: string, spaceName: string, ex: Ex): Promise<void>;
  markConferenceStarted(id: string, startedAt: Date, seenAt: Date, ex: Ex): Promise<void>;
  markConferenceEnded(id: string, endedAt: Date, seenAt: Date, ex: Ex): Promise<void>;
  markConferenceEndedEarly(id: string, endedAt: Date, seenAt: Date, ex: Ex): Promise<void>;
  /** `reason` é opcional: a admissão não o guarda (vai só à trilha); o enquadre o grava em `blocked_reason`. */
  markBlocked(id: string, ex: Ex, reason?: string): Promise<void>;
  markNoShow(id: string, ex: Ex): Promise<void>;
}

/** Detectores de silêncio e de entrega da admissão (mensagens do WhatsApp). O enquadre não os tem: a dependência é opcional. */
export interface PostCallDetectors {
  findReminderSilence(now: Date): Promise<string[]>;
  findConfirmationSilence(now: Date): Promise<string[]>;
  findStaleSentMessages(now: Date): Promise<Array<{ messageId: string; appointmentId: string }>>;
}

/** DESTINO (trilha), do fim de call e da importação: `appointmentId` carrega o id do sujeito (reunião da admissão ou evento do enquadre). `ex` = a transação do chamador. */
export interface SubjectTrail {
  append(event: AdmissionEventInput, ex?: Ex): Promise<void>;
}

/** Como o job nomeia seus logs: o prefixo (`admission.*` / `enquadre.*`, que as métricas filtram) e a chave do id do sujeito. */
export interface PostCallNaming {
  prefix: string;
  idKey: string;
}
export const ADMISSION_POST_CALL_NAMING: PostCallNaming = { prefix: 'admission', idKey: 'appointmentId' };
