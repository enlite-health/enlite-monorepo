import * as functions from 'firebase-functions';
import { reportError } from '@shared/logging';
import { inPatientTransaction } from './patientTransaction';
import { movePatientStatus, PatientStatusNotReadyError } from './PatientStatusWriter';
import { isAdmissionFunnelStatus } from '../domain/enums/PatientStatus';

/**
 * VacancyLaunchHook — o LANÇAMENTO da vaga (envio à Talentum) tira o paciente do funil de
 * Admissão (invariante 7, D434; cadeia Fase 6, DX-6.1).
 *
 * NESTA ROTA o gancho SÓ move o paciente (Admisión → Búsqueda). O match do lançamento volta na
 * rota (a), junto com Compatíveis (D466): gravar `worker_job_applications` `'INVITED','system'`
 * aqui faria o convite automático (`VacancyAutoInviteHandler`) pular quem já tem linha.
 *
 * Chamado por `PublishVacancyToTalentumUseCase` DEPOIS do COMMIT do envio — nunca antes. Nenhum
 * evento novo é emitido; o convite (`vacancy.created` → `VacancyAutoInviteHandler`) é outro
 * gatilho e NÃO é ligado aqui.
 *
 * `onVacancyLaunched` NUNCA lança (DX-6.2): o envio à Talentum já está commitado e desfazer
 * exigiria um DELETE compensatório no canal externo — pior que o defeito. Sem retry automático:
 * o gancho é re-disparável de forma idempotente (despublicar/publicar de novo refaz tudo).
 */

/** Alvo do lançamento: paciente da vaga (se houver) e a coordenada do serviço. */
export interface LaunchTarget {
  patientId: string | null;
  patientStatus: string | null;
  lat: number | null;
  lng: number | null;
}

export interface VacancyLaunchOutcome {
  jobPostingId: string;
  patient: 'no_target' | 'no_patient' | 'patient_not_visible' | 'unchanged' | 'moved' | 'not_ready' | 'failed';
}

export interface VacancyLaunchDeps {
  moveStatus: typeof movePatientStatus;
  readLaunchTarget: (jobPostingId: string) => Promise<LaunchTarget | null>;
}

/**
 * Lê o alvo do lançamento — paciente e coordenada do serviço — dentro de `inPatientTransaction`
 * (DX-6.7, RLS de país por `withActorContext`). Nunca `pool.query`/`this.db.query` cru em
 * `patients` (migration 271; memória `connect-cru-sem-actor-context-da-500`): sob RLS isso volta
 * ZERO linhas silenciosamente. `jp.is_draft = false`: vaga ainda em rascunho não é alvo de
 * lançamento (o publish só chega aqui depois do envio confirmado).
 */
export async function readLaunchTarget(jobPostingId: string): Promise<LaunchTarget | null> {
  return inPatientTransaction(async (client) => {
    const result = await client.query<{
      patient_id: string | null;
      status: string | null;
      lat: string | null;
      lng: string | null;
    }>(
      `SELECT jp.patient_id, p.status, pa.lat, pa.lng
       FROM job_postings jp
       LEFT JOIN patients p ON p.id = jp.patient_id AND p.deleted_at IS NULL
       LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
       WHERE jp.id = $1 AND jp.deleted_at IS NULL AND jp.is_draft = false`,
      [jobPostingId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      patientId: row.patient_id,
      patientStatus: row.status,
      lat: row.lat !== null ? parseFloat(row.lat) : null,
      lng: row.lng !== null ? parseFloat(row.lng) : null,
    };
  });
}

const defaultLaunchDeps: VacancyLaunchDeps = {
  moveStatus: movePatientStatus,
  readLaunchTarget,
};

/** Mover o paciente para SEARCHING se (e só se) ele estiver no funil de Admissão. */
async function movePatientIfInFunnel(
  jobPostingId: string,
  target: LaunchTarget,
  deps: VacancyLaunchDeps,
): Promise<VacancyLaunchOutcome['patient']> {
  if (!target.patientId) return 'no_patient';
  if (target.patientStatus === null) {
    // `jp.patient_id` existe mas o LEFT JOIN em `patients` (readLaunchTarget) voltou vazio: RLS
    // escondeu o paciente ao ator (país não bate) ou o registro sumiu por fora do `deleted_at`
    // filtrado na query. Distinto de `no_patient` (vaga sem paciente): aqui HÁ paciente, só não é
    // visível. Achado A5 (veredito parcial 1): antes disto virava 'unchanged' sem alarme nenhum.
    functions.logger.warn('vacancy_launch.patient_not_visible', { jobPostingId, patientId: target.patientId });
    return 'patient_not_visible';
  }
  if (!isAdmissionFunnelStatus(target.patientStatus)) return 'unchanged';

  try {
    await deps.moveStatus(target.patientId, 'SEARCHING', { changeSource: 'vacancy_launch' });
    return 'moved';
  } catch (err) {
    if (err instanceof PatientStatusNotReadyError) {
      functions.logger.warn('vacancy_launch.patient_not_moved', {
        jobPostingId,
        patientId: target.patientId,
        code: err.code,
        missing: err.missing,
      });
      return 'not_ready';
    }
    const error = err instanceof Error ? err : new Error(String(err));
    functions.logger.error('vacancy_launch.failed', { jobPostingId, step: 'move', error: error.message });
    reportError(error, { source: 'VacancyLaunchHook:move' });
    return 'failed';
  }
}

export async function onVacancyLaunched(
  jobPostingId: string,
  deps: VacancyLaunchDeps = defaultLaunchDeps,
): Promise<VacancyLaunchOutcome> {
  const target = await deps.readLaunchTarget(jobPostingId);
  if (!target) {
    functions.logger.warn('vacancy_launch.no_target', { jobPostingId });
    const outcome: VacancyLaunchOutcome = { jobPostingId, patient: 'no_target' };
    functions.logger.info('vacancy_launch.done', { jobPostingId, patient: outcome.patient });
    return outcome;
  }

  const patient = await movePatientIfInFunnel(jobPostingId, target, deps);

  functions.logger.info('vacancy_launch.done', { jobPostingId, patient });
  return { jobPostingId, patient };
}
