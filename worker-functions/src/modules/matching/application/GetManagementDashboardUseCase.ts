import type { Pool } from 'pg';
import { managementDashboardSchema, type ManagementDashboardData } from './managementDashboardSchema';
import { GetArmedCasesUseCase } from './GetArmedCasesUseCase';

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
    const [armed, jobRows, patientRows, workerRow, funnelRows, allocatedRow, blockedRow, encuadreRow] =
      await Promise.all([
        // Equipe Armada + horas: agregação por caso (buckets honestos, ver
        // GetArmedCasesUseCase). É a 1ª promise → 1ª chamada a this.db.query.
        new GetArmedCasesUseCase(this.db).execute(),
        this.db.query<CountRow>(
          `SELECT status AS k, COUNT(*)::int AS count
             FROM job_postings
            WHERE deleted_at IS NULL AND is_draft = false
            GROUP BY status`,
        ),
        this.db.query<{ activos: number }>(
          `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS activos FROM patients`,
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
          `SELECT COUNT(*)::int AS bloqueados
             FROM worker_blocked_applications
            WHERE blocked_reason = 'registration_incomplete'`,
        ),
        this.db.query<{ agendados: number }>(
          `SELECT COUNT(*)::int AS agendados
             FROM encuadres
            WHERE interview_date >= date_trunc('week', CURRENT_DATE)
              AND interview_date <  date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'`,
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
        completosEsperandoAgendamiento: pick(funnel, 'QUALIFIED'),
        profesionalesBloqueados: worker.incompletos,
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
