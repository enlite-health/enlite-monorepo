import type { Pool } from 'pg';

export interface WorkerApplicationItem {
  /** Título do caso como o candidato conhece (ex.: "CASO 210-2079"). */
  caseTitle: string;
  /** Etapa AMIGÁVEL pro candidato — nunca o enum interno cru. */
  stage: string;
  appliedAt: string;
}

export interface ListWorkerApplicationsResult {
  applications: WorkerApplicationItem[];
}

/**
 * Etapas internas → rótulo que a Luz pode falar com o candidato (es-AR).
 * REJECTED vira neutro ("no avanzó esta vez") — a comunicação de recusa tem
 * dono humano; a Luz não deve cravar motivo.
 */
const STAGE_LABELS: Record<string, string> = {
  INVITED: 'invitación enviada',
  INITIATED: 'postulación recibida',
  PRE_SCREENING: 'en revisión',
  IN_PROGRESS: 'en proceso',
  COMPLETED: 'proceso completado',
  QUALIFIED: 'calificada — próximo paso: entrevista',
  IN_DOUBT: 'en revisión',
  CONFIRMED: 'confirmada',
  SELECTED: 'seleccionada 🎉',
  REJECTED: 'no avanzó esta vez',
};

/**
 * ListWorkerApplicationsUseCase (D89 item 5) — postulações do PRÓPRIO worker,
 * pra Luz responder "¿llegó mi postulación?". Só caso + etapa + data; NENHUM
 * dado de paciente sai daqui.
 */
export class ListWorkerApplicationsUseCase {
  constructor(private readonly pool: Pool) {}

  async execute(workerId: string): Promise<ListWorkerApplicationsResult> {
    const { rows } = await this.pool.query(
      `SELECT jp.title, wja.application_funnel_stage AS stage, wja.created_at
         FROM worker_job_applications wja
         JOIN job_postings jp ON jp.id = wja.job_posting_id
        WHERE wja.worker_id = $1
        ORDER BY wja.created_at DESC
        LIMIT 20`,
      [workerId],
    );
    return {
      applications: rows.map((r) => ({
        caseTitle: String(r.title ?? 'caso'),
        stage: STAGE_LABELS[String(r.stage)] ?? 'en proceso',
        appliedAt: new Date(r.created_at).toISOString(),
      })),
    };
  }
}
