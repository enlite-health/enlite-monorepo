import type { Pool } from 'pg';
import { managementDashboardSchema, type ManagementDashboardData } from './managementDashboardSchema';
import { GetArmedCasesUseCase } from './GetArmedCasesUseCase';
import { GetFunnelByWorkerUseCase } from './GetFunnelByWorkerUseCase';
import {
  INTERVIEW_DATE_RESOLVED_SQL,
  CURRENT_WEEK_START_SQL,
} from '../domain/interviewSchedule';
import { LIVE_JOB_POSTING_SQL } from '../domain/openJobStatuses';
import {
  excludeDisabledWorkersSql,
  workerNotDisabledSql,
} from '@shared/database/activeWorkerFilter';
import {
  computeScheduleWeeklyHours,
  hasStructuredSchedule,
} from '../domain/scheduleHours';

/** Linha de contagem simples chave→valor. */
interface CountRow {
  k: string;
  count: number;
}

export interface ManagementDashboardOptions {
  /** Filtro por ENTRADA no funil por prestador (7/30/90 dias). Ausente = tudo. */
  funnelPeriodDays?: number;
}

/**
 * Capacidade semanal contratada de encuadres (reuniões de coordenação).
 * Origem: call 22/07 (Marcel, 01:53 — "80 reuniões = 40h × 2/h, contratadas"),
 * confirmada em 30/07 com pedido explícito de ser CONFIGURÁVEL.
 * REVISADA para 30 na call de produto de 12/08 (Diego/Marcel, task 86ak04ygv):
 * o denominador passa a refletir a capacidade real da coordenação. Zero/inválida →
 * o percentual é OMITIDO do payload (nunca divisão por zero, nunca 0% falso).
 */
function readEncuadreWeeklyCapacity(): number | null {
  const raw = process.env.ENCUADRE_WEEKLY_CAPACITY ?? '30';
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Agrega as métricas do "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw).
 *
 * READ-ONLY: apenas COUNT/GROUP BY sobre tabelas existentes. Nunca toca colunas
 * *_encrypted (zero PII). Não cria tabelas nem inventa colunas — cada número tem
 * fonte verificada. A saída é validada pelo Zod antes de retornar.
 */
export class GetManagementDashboardUseCase {
  constructor(private readonly db: Pool) {}

  async execute(options?: ManagementDashboardOptions): Promise<ManagementDashboardData> {
    // Equipe Armada RODA ANTES do Promise.all: o card "Em Busca" precisa dos ids
    // dos casos ARMADA (classificação de domínio em JS — nunca replicada em SQL).
    // Custo: 1 query serializada (~17ms em prod, medido na change anterior).
    const armed = await new GetArmedCasesUseCase(this.db).execute();

    const [
      funnelPorPrestador,
      jobRows,
      patientRows,
      pacienteEstadosRow,
      ubicacionesRow,
      horasAtivasRows,
      workerRow,
      funnelRows,
      esperandoRow,
      allocatedRow,
      blockedRow,
      encuadreRow,
    ] =
      await Promise.all([
        // Funil por PRESTADOR, recortado à operação viva (ver GetFunnelByWorkerUseCase).
        new GetFunnelByWorkerUseCase(this.db).execute(options?.funnelPeriodDays),
        this.db.query<CountRow>(
          `SELECT status AS k, COUNT(*)::int AS count
             FROM job_postings
            WHERE deleted_at IS NULL AND is_draft = false
            GROUP BY status`,
        ),
        this.db.query<{ activos: number }>(
          // deleted_at IS NULL: paciente soft-deletado não está em atenção. Sem
          // esse filtro o card contava 192 em vez de 190 (2 apagados em prod).
          `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS activos
             FROM patients
            WHERE deleted_at IS NULL`,
        ),
        this.db.query<{
          solicitudes: number;
          entrevista_agendada: number;
          en_admision: number;
          en_busca: number;
        }>(
          // Linha CHEGANDO (Diego, 30/07): 4 estados ATUAIS com precedência exclusiva
          // Em Busca > Em Admissão > Entrevista Agendada > Solicitações.
          // - Em Busca: ≥1 vaga viva de caso NÃO-ARMADA ($1 = ids ARMADA vindos do
          //   classificador de domínio), status não-terminal. Vaga viva de paciente
          //   DISCONTINUED/DISCHARGED é zumbi de dado (16 em prod, 31/07) — fora.
          // - Em Admissão: ADMISSION/PENDING_ADMISSION ainda sem vaga ("precisam
          //   gerar vacante").
          // - Entrevista Agendada: admission_appointments 'booked' no futuro.
          `WITH base AS (
             SELECT p.status,
               EXISTS (
                 SELECT 1 FROM job_postings jp
                  WHERE jp.patient_id = p.id AND ${LIVE_JOB_POSTING_SQL}
                    AND NOT (jp.id = ANY($1::uuid[]))
               ) AS em_busca_vaga,
               EXISTS (
                 SELECT 1 FROM admission_appointments aa
                  WHERE aa.patient_id = p.id AND aa.status = 'booked' AND aa.slot_start > NOW()
               ) AS entrevista_futura
             FROM patients p
             WHERE p.deleted_at IS NULL AND COALESCE(p.is_test, false) = false
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
          [armed.armadaCaseIds],
        ),
        this.db.query<{ ubicaciones: number }>(
          // Ubicaciones DISTINTAS de pacientes ativos (D8). Dedup por (paciente,
          // texto do endereço): a importação grava linhas repetidas — 566 cruas
          // viram 339 reais (prod, 31/07). Endereço vazio não é ubicación.
          `SELECT COUNT(*)::int AS ubicaciones FROM (
             SELECT DISTINCT pa.patient_id,
               COALESCE(NULLIF(TRIM(pa.address_formatted), ''), NULLIF(TRIM(pa.address_raw), '')) AS addr
             FROM patient_addresses pa
             JOIN patients p ON p.id = pa.patient_id
             WHERE p.deleted_at IS NULL AND COALESCE(p.is_test, false) = false
               AND p.status = 'ACTIVE'
               AND COALESCE(NULLIF(TRIM(pa.address_formatted), ''), NULLIF(TRIM(pa.address_raw), '')) IS NOT NULL
           ) u`,
        ),
        this.db.query<{ schedule: unknown }>(
          // Horas EM ATENDIMENTO (linha RODANDO, D2 resolvida 31/07): vagas
          // status='ACTIVE' — fora do recorte "vivo", que é só busca. O parser de
          // horas é o mesmo do domínio (computeScheduleWeeklyHours), em JS.
          `SELECT jp.schedule
             FROM job_postings jp
             JOIN patients p ON p.id = jp.patient_id
            WHERE jp.deleted_at IS NULL AND jp.is_draft = false AND jp.status = 'ACTIVE'
              AND p.deleted_at IS NULL AND COALESCE(p.is_test, false) = false`,
        ),
        this.db.query<{
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
             AND ${excludeDisabledWorkersSql('w')}`,
        ),
        this.db.query<CountRow>(
          `SELECT application_funnel_stage AS k, COUNT(*)::int AS count
             FROM worker_job_applications wja
            WHERE ${workerNotDisabledSql('wja.worker_id')}
            GROUP BY application_funnel_stage`,
        ),
        this.db.query<{ esperando: number }>(
          // "Completos esperando agenda" é FILA DE CONTATO: quem ligar primeiro.
          // Conta PESSOAS distintas em VAGA VIVA. Sem esse recorte eram 2.429 candidaturas
          // (incluindo vaga apagada, rascunho e fechada, e a mesma pessoa N vezes);
          // o trabalho real são 569 pessoas — 4,3× menos.
          `SELECT COUNT(DISTINCT wja.worker_id)::int AS esperando
             FROM worker_job_applications wja
             JOIN job_postings jp ON jp.id = wja.job_posting_id
             JOIN workers      w  ON w.id  = wja.worker_id
            WHERE wja.application_funnel_stage = 'QUALIFIED'
              AND ${LIVE_JOB_POSTING_SQL}
              AND w.merged_into_id IS NULL
              -- fila de contato: quem deu baixa não deve ser ligado
              AND ${excludeDisabledWorkersSql('w')}`,
        ),
        this.db.query<{ activos: number; cubriendo_guardias: number }>(
          // "Alocados" = prestadores EM UM CASO segundo o Ana Care (workers.ana_care_status),
          // não o funil. O funil ('SELECTED') morre antes da alocação real — overlap ZERO
          // com quem atende paciente (verificado prod 22/07). Ver decisoes.md D53.
          // Composição explícita: 'Activo' = ocupado num paciente; 'Cubriendo guardias' =
          // disponível cobrindo plantão (migração 049). O card mostra os dois separados.
          // ⚠️ ana_care_status é FOTO de import — NÃO sincroniza ao vivo (zero writers inbound;
          // a integração AnaCare é outbound-only). Leitura viva depende do conector inbound
          // Ana Care (ClickUp 86ajgv39a, 31/07).
          `SELECT
             COUNT(*) FILTER (WHERE ana_care_status = 'Activo')::int             AS activos,
             COUNT(*) FILTER (WHERE ana_care_status = 'Cubriendo guardias')::int AS cubriendo_guardias
             FROM workers
            WHERE merged_into_id IS NULL
              AND ana_care_status IN ('Activo', 'Cubriendo guardias')`,
        ),
        this.db.query<{ bloqueados: number }>(
          // Tentativas de candidatura barradas pelo gate de cadastro incompleto.
          // Conta PESSOAS distintas em VAGA VIVA: é fila de trabalho ("quem quis
          // trabalhar e não conseguiu"), não acervo. Sem o recorte eram 668; com ele, 355.
          `SELECT COUNT(DISTINCT b.worker_id)::int AS bloqueados
             FROM worker_blocked_applications b
             JOIN job_postings jp ON jp.id = b.job_posting_id
            WHERE b.blocked_reason = 'registration_incomplete'
              AND ${LIVE_JOB_POSTING_SQL}
              -- fila de trabalho: quem deu baixa não é mais destravável
              AND ${workerNotDisabledSql('b.worker_id')}`,
        ),
        this.db.query<{ agendados: number; sem_data: number }>(
          // Entrevistas da semana + quantos cards estão em "Agendados" SEM data.
          //
          // O card mostrava 0 desde sempre: lia só `encuadres.interview_date`, campo que
          // nenhuma origem do produto jamais preencheu (as 9.214 datas vieram todas da
          // importação de 22-23/03/2026). Agora resolve as duas fontes pelo helper
          // compartilhado e conta a semana no fuso da OPERAÇÃO, não em UTC.
          //
          // `semData` é a medida de ADOÇÃO da captura (design D4): enquanto for alto, o
          // número da semana subestima — e isso fica visível em vez de virar zero mudo.
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
            WHERE ${workerNotDisabledSql('wja.worker_id')}`,
        ),
      ]);

    const jobs = toRecord(jobRows.rows);
    const funnel = toRecord(funnelRows.rows);

    const patient = patientRows.rows[0] ?? { activos: 0 };
    const estados = pacienteEstadosRow.rows[0] ?? {
      solicitudes: 0,
      entrevista_agendada: 0,
      en_admision: 0,
      en_busca: 0,
    };
    const ubicaciones = ubicacionesRow.rows[0]?.ubicaciones ?? 0;

    // Horas ativas: soma em JS com o parser de domínio (mesmo padrão do armed).
    let horasAtivas = 0;
    let ativasConSchedule = 0;
    let ativasSinSchedule = 0;
    for (const row of horasAtivasRows.rows) {
      horasAtivas += computeScheduleWeeklyHours(row.schedule);
      if (hasStructuredSchedule(row.schedule)) ativasConSchedule += 1;
      else ativasSinSchedule += 1;
    }

    const capacidadeSemana = readEncuadreWeeklyCapacity();
    const worker = workerRow.rows[0] ?? { leads: 0, completos: 0, incompletos: 0, nuevos: 0 };
    const alocadosActivos = allocatedRow.rows[0]?.activos ?? 0;
    const alocadosCubriendoGuardias = allocatedRow.rows[0]?.cubriendo_guardias ?? 0;
    const allocated = alocadosActivos + alocadosCubriendoGuardias;
    const blocked = blockedRow.rows[0]?.bloqueados ?? 0;
    const encuadre = encuadreRow.rows[0]?.agendados ?? 0;
    const encuadreSemData = encuadreRow.rows[0]?.sem_data ?? 0;

    // Vagas abertas POR STATUS — conceito distinto de "equipe por armar" (bucket).
    // Mantido como estava para não quebrar vacantesAbiertas (teste de regressão).
    const openByStatus =
      pick(jobs, 'SEARCHING') + pick(jobs, 'SEARCHING_REPLACEMENT') + pick(jobs, 'RAPID_RESPONSE');

    const data: ManagementDashboardData = {
      bigNumbers: {
        // Agora baseado na regra "Equipe Armada" (não mais job_postings.status).
        equiposArmados: armed.armados,
        equiposPorArmar: armed.porArmar,
        pacientesActivos: patient.activos,
        vacantesAbiertas: openByStatus + pick(jobs, 'PENDING_ACTIVATION'),
        vacantesPausadas: pick(jobs, 'SUSPENDED'),
      },
      equipoArmada: {
        armados: armed.armados,
        porArmar: armed.porArmar,
        semConfig: armed.semConfig,
        pendenteClasificacao: armed.pendenteClasificacao,
        pctRespostaRapidaArmado: {
          num: armed.respostaRapida.num,
          den: armed.respostaRapida.den,
          excluidos: armed.respostaRapida.excluidos,
          pct:
            armed.respostaRapida.den > 0
              ? round1Pct((armed.respostaRapida.num / armed.respostaRapida.den) * 100)
              : null,
        },
      },
      pacientes: {
        activos: patient.activos,
        ubicacionesActivas: ubicaciones,
        solicitudes: estados.solicitudes,
        entrevistaAgendada: estados.entrevista_agendada,
        enAdmision: estados.en_admision,
        enBusca: estados.en_busca,
        sobrepoe: true,
      },
      horas: {
        totais: armed.horasTotais,
        aPreencher: armed.horasAPreencher,
        ativas: round1(horasAtivas),
        ativasConSchedule,
        ativasSinSchedule,
        coberturaConSchedule: armed.coberturaConSchedule,
        coberturaSinSchedule: armed.coberturaSinSchedule,
      },
      prioridades: {
        // Pessoas distintas em vaga viva — fila de contato, não acervo de candidaturas.
        completosEsperandoAgendamiento: esperandoRow.rows[0]?.esperando ?? 0,
        // registrosIncompletos: backlog de import (workers.status INCOMPLETE_REGISTER),
        // deduplicado por pessoa — não é bloqueio de postulação.
        registrosIncompletos: worker.incompletos,
        // bloqueadosAlPostularse: pessoas distintas barradas pelo gate de cadastro
        // incompleto ao tentar se candidatar, já recortado a vaga viva + não desativado
        // (mesma fonte/filtro de funnel.bloqueados — ver query `blockedRow` acima).
        bloqueadosAlPostularse: blocked,
      },
      funnelPorPrestador: {
        total: funnelPorPrestador.total,
        recorte: 'vagas-vivas',
        periodoDias: options?.funnelPeriodDays ?? null,
        bloqueados: blocked,
        porEtapa: { somavel: false, colunas: funnelPorPrestador.porEtapa },
        consolidado: { somavel: true, colunas: funnelPorPrestador.consolidado },
      },
      funnel: {
        invitados: pick(funnel, 'INVITED'),
        bloqueados: blocked,
        preScreening: pick(funnel, 'PRE_SCREENING'),
        completos: pick(funnel, 'COMPLETED'),
        agendados: pick(funnel, 'CONFIRMED'),
        seleccionados: pick(funnel, 'SELECTED'),
        rechazados: pick(funnel, 'REJECTED'),
      },
      encuadres: {
        agendadosEstaSemana: encuadre,
        semDataRegistrada: encuadreSemData,
        // Omitido quando a capacidade está zerada/inválida (nunca 0% fabricado).
        ...(capacidadeSemana != null
          ? {
              pctCapacidadeSemana: {
                agendados: encuadre,
                capacidade: capacidadeSemana,
                pct: round1Pct((encuadre / capacidadeSemana) * 100),
              },
            }
          : {}),
      },
      cadastros: {
        leads: worker.leads,
        completos: worker.completos,
        alocados: allocated,
        alocadosActivos,
        alocadosCubriendoGuardias,
        incompletos: worker.incompletos,
        nuevosCompletosMes: worker.nuevos,
      },
    };

    // Contrato: garante que nenhum número negativo/NaN escape (defesa em profundidade).
    return managementDashboardSchema.parse(data);
  }
}

function toRecord(rows: CountRow[]): Record<string, number> {
  const record: Record<string, number> = {};
  for (const row of rows) {
    if (row.k != null) record[row.k] = row.count;
  }
  return record;
}

function pick(record: Record<string, number>, key: string): number {
  return record[key] ?? 0;
}

/** Arredonda a 1 casa (mesma convenção de scheduleHours). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Percentual com 1 casa — 0.0 real continua 0.0; nunca NaN (guard no caller). */
function round1Pct(value: number): number {
  return Math.round(value * 10) / 10;
}
