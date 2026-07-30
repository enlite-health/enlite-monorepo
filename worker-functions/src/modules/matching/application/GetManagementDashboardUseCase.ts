import type { Pool } from 'pg';
import { managementDashboardSchema, type ManagementDashboardData } from './managementDashboardSchema';
import { GetArmedCasesUseCase } from './GetArmedCasesUseCase';
import { GetFunnelByWorkerUseCase } from './GetFunnelByWorkerUseCase';
import {
  INTERVIEW_DATE_RESOLVED_SQL,
  CURRENT_WEEK_START_SQL,
} from '../domain/interviewSchedule';
import { LIVE_JOB_POSTING_SQL } from '../domain/openJobStatuses';

/** Linha de contagem simples chave→valor. */
interface CountRow {
  k: string;
  count: number;
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

  async execute(): Promise<ManagementDashboardData> {
    const [
      armed,
      funnelPorPrestador,
      jobRows,
      patientRows,
      workerRow,
      funnelRows,
      esperandoRow,
      allocatedRow,
      blockedRow,
      encuadreRow,
    ] =
      await Promise.all([
        // Equipe Armada + horas: agregação por caso (buckets honestos, ver
        // GetArmedCasesUseCase). É a 1ª promise → 1ª chamada a this.db.query.
        new GetArmedCasesUseCase(this.db).execute(),
        // Funil por PRESTADOR, recortado à operação viva (ver GetFunnelByWorkerUseCase).
        new GetFunnelByWorkerUseCase(this.db).execute(),
        this.db.query<CountRow>(
          `SELECT status AS k, COUNT(*)::int AS count
             FROM job_postings
            WHERE deleted_at IS NULL AND is_draft = false
            GROUP BY status`,
        ),
        this.db.query<{ activos: number }>(
          // `deleted_at IS NULL` faltava: contava 2 pacientes apagados (192 × 190 real,
          // verificado em prod 30/07). Todas as outras queries do dashboard já filtram.
          `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS activos
             FROM patients
            WHERE deleted_at IS NULL`,
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
           FROM workers
           WHERE merged_into_id IS NULL`,
        ),
        this.db.query<CountRow>(
          `SELECT application_funnel_stage AS k, COUNT(*)::int AS count
             FROM worker_job_applications
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
              AND w.merged_into_id IS NULL`,
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
              AND ${LIVE_JOB_POSTING_SQL}`,
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
                   AND e.job_posting_id = wja.job_posting_id`,
        ),
      ]);

    const jobs = toRecord(jobRows.rows);
    const funnel = toRecord(funnelRows.rows);

    const patient = patientRows.rows[0] ?? { activos: 0 };
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
      },
      horas: {
        totais: armed.horasTotais,
        aPreencher: armed.horasAPreencher,
        coberturaConSchedule: armed.coberturaConSchedule,
        coberturaSinSchedule: armed.coberturaSinSchedule,
      },
      prioridades: {
        // Pessoas distintas em vaga viva — fila de contato, não acervo de candidaturas.
        completosEsperandoAgendamiento: esperandoRow.rows[0]?.esperando ?? 0,
        profesionalesBloqueados: worker.incompletos,
      },
      funnelPorPrestador: {
        total: funnelPorPrestador.total,
        recorte: 'vagas-vivas',
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
