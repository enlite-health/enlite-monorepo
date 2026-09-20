/**
 * src/modules/matching/application/managementDashboardQueries.ts
 *
 * As 11 queries escalares do "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw)
 * que NÃO são delegadas a um use case próprio (armed/funnelPorPrestador vivem em
 * `GetArmedCasesUseCase`/`GetFunnelByWorkerUseCase`). Extraído de
 * `GetManagementDashboardUseCase.ts` no PR-9 (`lex` #9) só para caber no teto de
 * 400 linhas por arquivo — nenhuma query mudou de forma além do predicado de
 * país (FR-732) que o PR-9 introduziu.
 *
 * Cada função devolve a PROMISE de `db.query(...)` direto — quem chama monta o
 * `Promise.all` na MESMA ordem de sempre (é o que a suíte de
 * `GetManagementDashboardUseCase.test.ts` trava por índice posicional).
 */

import type { Pool } from 'pg';
import { LIVE_JOB_POSTING_SQL } from '../domain/openJobStatuses';
import {
  liveWorkerJoinSql,
  liveBlockedReasonSql,
} from '../infrastructure/blockedAttemptLiveState';
import {
  excludeDisabledWorkersSql,
  workerNotDisabledSql,
} from '@shared/database/activeWorkerFilter';
import {
  countryPredicateSql,
  workerCountryPredicateSql,
} from '@shared/database/countryScopeSql';
import {
  INTERVIEW_DATE_RESOLVED_SQL,
  CURRENT_WEEK_START_SQL,
} from '../domain/interviewSchedule';
import type { CountryCode } from '@shared/domain/countryCodes';

/** Linha de contagem simples chave→valor. */
export interface CountRow {
  k: string;
  count: number;
}

/** `job_postings` por status (não-draft, não-deletada). */
export function jobStatusCountsQuery(db: Pool, countries: CountryCode[]) {
  return db.query<CountRow>(
    `SELECT status AS k, COUNT(*)::int AS count
       FROM job_postings
      WHERE deleted_at IS NULL AND is_draft = false
        AND ${countryPredicateSql('job_postings', 1)}
      GROUP BY status`,
    [countries],
  );
}

/** Pacientes ativos (deleted_at IS NULL: soft-deletado não está em atenção). */
export function patientsActiveCountQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{ activos: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS activos
       FROM patients
      WHERE deleted_at IS NULL
        AND ${countryPredicateSql('patients', 1)}`,
    [countries],
  );
}

/**
 * Linha CHEGANDO (Diego, 30/07): 4 estados ATUAIS com precedência exclusiva
 * Em Busca > Em Admissão > Entrevista Agendada > Solicitações.
 * - Em Busca: ≥1 vaga viva de caso NÃO-ARMADA (`armadaCaseIds`), status não-terminal.
 * - Em Admissão: ADMISSION/PENDING_ADMISSION ainda sem vaga.
 * - Entrevista Agendada: admission_appointments 'booked' no futuro.
 */
export function pacienteEstadosQuery(db: Pool, armadaCaseIds: string[], countries: CountryCode[]) {
  return db.query<{
    solicitudes: number;
    entrevista_agendada: number;
    en_admision: number;
    en_busca: number;
  }>(
    `WITH base AS (
       SELECT p.status,
         EXISTS (
           SELECT 1 FROM job_postings jp
            WHERE jp.patient_id = p.id AND ${LIVE_JOB_POSTING_SQL}
              AND NOT (jp.id = ANY($1::uuid[]))
              AND ${countryPredicateSql('jp', 2)}
         ) AS em_busca_vaga,
         EXISTS (
           SELECT 1 FROM admission_appointments aa
            WHERE aa.patient_id = p.id AND aa.status = 'booked' AND aa.slot_start > NOW()
         ) AS entrevista_futura
       FROM patients p
       WHERE p.deleted_at IS NULL AND COALESCE(p.is_test, false) = false
         AND ${countryPredicateSql('p', 2)}
     )
     SELECT
       COUNT(*) FILTER (
         WHERE em_busca_vaga AND status NOT IN ('DISCONTINUED', 'DISCHARGED')
       )::int AS en_busca,
       COUNT(*) FILTER (
         WHERE NOT em_busca_vaga AND status IN ('ADMISSION', 'PENDING_ADMISSION')
       )::int AS en_admision,
       COUNT(*) FILTER (
         WHERE NOT em_busca_vaga AND status = 'SOLICITANTE' AND entrevista_futura
       )::int AS entrevista_agendada,
       COUNT(*) FILTER (
         WHERE NOT em_busca_vaga AND status = 'SOLICITANTE' AND NOT entrevista_futura
       )::int AS solicitudes
     FROM base`,
    [armadaCaseIds, countries],
  );
}

/** Ubicaciones DISTINTAS de pacientes ativos (D8) — dedup por (paciente, texto). */
export function ubicacionesActivasQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{ ubicaciones: number }>(
    `SELECT COUNT(*)::int AS ubicaciones FROM (
       SELECT DISTINCT pa.patient_id,
         COALESCE(NULLIF(TRIM(pa.address_formatted), ''), NULLIF(TRIM(pa.address_raw), '')) AS addr
       FROM patient_addresses pa
       JOIN patients p ON p.id = pa.patient_id
       WHERE p.deleted_at IS NULL AND COALESCE(p.is_test, false) = false
         AND p.status = 'ACTIVE'
         AND ${countryPredicateSql('p', 1)}
         AND COALESCE(NULLIF(TRIM(pa.address_formatted), ''), NULLIF(TRIM(pa.address_raw), '')) IS NOT NULL
     ) u`,
    [countries],
  );
}

/** Horas EM ATENDIMENTO (linha RODANDO, D2): vagas `status='ACTIVE'`. */
export function horasAtivasQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{ schedule: unknown }>(
    `SELECT jp.schedule
       FROM job_postings jp
       JOIN patients p ON p.id = jp.patient_id
      WHERE jp.deleted_at IS NULL AND jp.is_draft = false AND jp.status = 'ACTIVE'
        AND p.deleted_at IS NULL AND COALESCE(p.is_test, false) = false
        AND ${countryPredicateSql('jp', 1)}`,
    [countries],
  );
}

/** Cadastros de prestadores (leads/completos/incompletos/novos no mês). */
export function workerCadastrosQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{
    leads: number;
    completos: number;
    incompletos: number;
    nuevos: number;
  }>(
    `SELECT
       COUNT(*)::int AS leads,
       COUNT(*) FILTER (WHERE status = 'REGISTERED')::int AS completos,
       COUNT(*) FILTER (WHERE status = 'INCOMPLETE_REGISTER')::int AS incompletos,
       COUNT(*) FILTER (
         WHERE status = 'REGISTERED' AND created_at >= date_trunc('month', CURRENT_DATE)
       )::int AS nuevos
     FROM workers w
     WHERE merged_into_id IS NULL
       -- quem deu baixa sai do acervo de prestadores; a contagem de
       -- desativados vive em GET /workers/status ("Desativados")
       AND ${excludeDisabledWorkersSql('w')}
       AND ${countryPredicateSql('w', 1)}`,
    [countries],
  );
}

/** @deprecated Totalização do funil por CANDIDATURA (legado — ver managementDashboardSchema). */
export function funnelLegadoQuery(db: Pool, countries: CountryCode[]) {
  return db.query<CountRow>(
    `SELECT application_funnel_stage AS k, COUNT(*)::int AS count
       FROM worker_job_applications wja
      WHERE ${workerNotDisabledSql('wja.worker_id')}
        AND ${workerCountryPredicateSql('wja.worker_id', 1)}
      GROUP BY application_funnel_stage`,
    [countries],
  );
}

/** "Completos esperando agenda" — pessoas distintas em vaga viva. */
export function esperandoAgendaQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{ esperando: number }>(
    `SELECT COUNT(DISTINCT wja.worker_id)::int AS esperando
       FROM worker_job_applications wja
       JOIN job_postings jp ON jp.id = wja.job_posting_id
       JOIN workers      w  ON w.id  = wja.worker_id
      WHERE wja.application_funnel_stage = 'QUALIFIED'
        AND ${LIVE_JOB_POSTING_SQL}
        AND w.merged_into_id IS NULL
        -- fila de contato: quem deu baixa não deve ser ligado
        AND ${excludeDisabledWorkersSql('w')}
        AND ${countryPredicateSql('w', 1)}`,
    [countries],
  );
}

/** "Alocados" — prestadores EM UM CASO segundo o Ana Care (ver decisoes.md D53). */
export function alocadosAnaCareQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{ activos: number; cubriendo_guardias: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE ana_care_status = 'Activo')::int             AS activos,
       COUNT(*) FILTER (WHERE ana_care_status = 'Cubriendo guardias')::int AS cubriendo_guardias
       FROM workers
      WHERE merged_into_id IS NULL
        AND ana_care_status IN ('Activo', 'Cubriendo guardias')
        AND ${countryPredicateSql('workers', 1)}`,
    [countries],
  );
}

/**
 * Tentativas de candidatura barradas pelo gate de cadastro incompleto (vaga viva).
 *
 * 🔒 O motivo é o de HOJE, recalculado — não a coluna do instantâneo
 * (`blocked_reason`/`blocked_reason_at_attempt`). Esta era a QUINTA leitura, a
 * única que ficou de fora quando as outras quatro migraram para
 * `blockedAttemptLiveState` (D300/c6f7bb05), e por isso o card divergia das
 * demais telas: medido em produção, contava 735 onde a verdade era 583 (26% de
 * inflação). Ver `worker-functions/src/modules/matching/infrastructure/blockedAttemptLiveState.ts`.
 */
export function bloqueadosQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{ bloqueados: number }>(
    `SELECT COUNT(DISTINCT b.worker_id)::int AS bloqueados
       FROM worker_blocked_applications b
       JOIN job_postings jp ON jp.id = b.job_posting_id
       ${liveWorkerJoinSql('b')}
      WHERE ${liveBlockedReasonSql()} = 'registration_incomplete'
        AND ${LIVE_JOB_POSTING_SQL}
        -- fila de trabalho: quem deu baixa não é mais destravável
        AND ${workerNotDisabledSql('b.worker_id')}
        AND ${workerCountryPredicateSql('b.worker_id', 1)}`,
    [countries],
  );
}

/** Entrevistas da semana (fuso da operação) + cards "Agendados" sem data. */
export function encuadresSemanaQuery(db: Pool, countries: CountryCode[]) {
  return db.query<{ agendados: number; sem_data: number }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE ${INTERVIEW_DATE_RESOLVED_SQL} >= ${CURRENT_WEEK_START_SQL}::date
           AND ${INTERVIEW_DATE_RESOLVED_SQL} <  ${CURRENT_WEEK_START_SQL}::date + INTERVAL '7 days'
       )::int AS agendados,
       COUNT(*) FILTER (
         WHERE wja.application_funnel_stage = 'CONFIRMED'
           AND ${INTERVIEW_DATE_RESOLVED_SQL} IS NULL
       )::int AS sem_data
       FROM worker_job_applications wja
       LEFT JOIN encuadres e
              ON e.worker_id = wja.worker_id
             AND e.job_posting_id = wja.job_posting_id
      WHERE ${workerNotDisabledSql('wja.worker_id')}
        AND ${workerCountryPredicateSql('wja.worker_id', 1)}`,
    [countries],
  );
}
