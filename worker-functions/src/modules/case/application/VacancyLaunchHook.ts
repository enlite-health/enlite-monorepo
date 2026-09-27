import * as functions from 'firebase-functions';
import { reportError } from '@shared/logging';
import { inPatientTransaction } from './patientTransaction';
import { movePatientStatus, PatientStatusNotReadyError } from './PatientStatusWriter';
import { isAdmissionFunnelStatus } from '../domain/enums/PatientStatus';
// Caminho RELATIVO de propósito (DX-6.1): `matching` já importa `@modules/integration`
// (VacancyTalentumController.ts:4-13) — importar `matching` pelo barril `@modules/matching`
// fecharia um ciclo de módulo. Mesmo molde de PublishVacancyToTalentumUseCase.ts:21-24.
import {
  MatchmakingService,
  type MatchOptions,
  type MatchResult,
} from '../../matching/infrastructure/MatchmakingService';

/**
 * VacancyLaunchHook — o LANÇAMENTO da vaga (envio à Talentum) tira o paciente do funil de
 * Admissão e dispara o match SEM convite (invariante 7, D434; cadeia Fase 6, DX-6.1).
 *
 * Chamado por `PublishVacancyToTalentumUseCase` DEPOIS do COMMIT do envio — nunca antes. Nenhum
 * evento novo é emitido; o convite (`vacancy.created` → `VacancyAutoInviteHandler`) é outro
 * gatilho e NÃO é ligado aqui.
 *
 * `onVacancyLaunched` NUNCA lança (DX-6.2): o envio à Talentum já está commitado e desfazer
 * exigiria um DELETE compensatório no canal externo — pior que o defeito. Cada metade (mover o
 * paciente / rodar o match) tem o seu próprio try/catch; uma falhar não impede a outra. Sem retry
 * automático: as duas metades são re-disparáveis manualmente e de forma idempotente
 * (despublicar/publicar de novo refaz o gancho inteiro; o match tem botão manual em
 * `POST /vacancies/:id/match`).
 */

/**
 * Raio e topo do match do lançamento (DX-6.5, visível: sim — define quantos candidatos caem em
 * Compatíveis na hora do lançamento).
 *
 * `2026-09-23a#DEC-28`: candidatos = documentação completa, até 50 km, preferência humana pelos
 * mais próximos; o "5 km" do texto da fase não está na ata — Q-6.1.
 */
export const LAUNCH_MATCH_RADIUS_KM = 50;

/** Mesmo teto que a leitura de match-results já usa (`VacancyMatchController.getMatchResults`). */
export const LAUNCH_MATCH_TOP_N = 200;

/** Alvo do lançamento: paciente da vaga (se houver) e a coordenada do serviço. */
export interface LaunchTarget {
  patientId: string | null;
  patientStatus: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * `'skipped_no_target'` — a leitura do alvo não achou a vaga (inexistente/rascunho/apagada);
 * `'skipped_no_location'` — vaga sem coordenada de serviço (sem centro, o hard filter varreria a
 * base inteira); `{ candidates }` — o match rodou; `'failed'` — o match lançou (nunca propagado).
 */
export type VacancyLaunchMatchOutcome =
  | 'skipped_no_target'
  | 'skipped_no_location'
  | 'failed'
  | { candidates: number };

export interface VacancyLaunchOutcome {
  jobPostingId: string;
  patient: 'no_target' | 'no_patient' | 'patient_not_visible' | 'unchanged' | 'moved' | 'not_ready' | 'failed';
  match: VacancyLaunchMatchOutcome;
}

export interface VacancyLaunchDeps {
  moveStatus: typeof movePatientStatus;
  runMatch: (jobPostingId: string, options: MatchOptions) => Promise<MatchResult>;
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
  runMatch: (jobPostingId, options) => new MatchmakingService().matchWorkersForJob(jobPostingId, options),
  readLaunchTarget,
};

/** Metade 1: mover o paciente para SEARCHING se (e só se) ele estiver no funil de Admissão. */
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

/** Metade 2: rodar o match sem convite (DX-6.5) — roda mesmo que a metade 1 não tenha movido. */
async function runLaunchMatch(
  jobPostingId: string,
  target: LaunchTarget,
  deps: VacancyLaunchDeps,
): Promise<VacancyLaunchMatchOutcome> {
  if (target.lat === null || target.lng === null) return 'skipped_no_location';

  try {
    const result = await deps.runMatch(jobPostingId, {
      radiusKm: LAUNCH_MATCH_RADIUS_KM,
      topN: LAUNCH_MATCH_TOP_N,
      includeIncompleteRegister: false,
      excludeWithActiveCases: false,
    });
    return { candidates: result.candidates.length };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    functions.logger.error('vacancy_launch.failed', { jobPostingId, step: 'match', error: error.message });
    reportError(error, { source: 'VacancyLaunchHook:match' });
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
    const outcome: VacancyLaunchOutcome = { jobPostingId, patient: 'no_target', match: 'skipped_no_target' };
    functions.logger.info('vacancy_launch.done', { jobPostingId, patient: outcome.patient, match: outcome.match });
    return outcome;
  }

  const patient = await movePatientIfInFunnel(jobPostingId, target, deps);
  const match = await runLaunchMatch(jobPostingId, target, deps);

  functions.logger.info('vacancy_launch.done', { jobPostingId, patient, match });
  return { jobPostingId, patient, match };
}
