import type { Pool } from 'pg';
import {
  patientFunnelSchema,
  type PatientFunnelData,
  type PatientFunnelQuery,
} from './patientFunnelSchema';
import type { CountryCode } from '@shared/domain/countryCodes';

interface CountRow {
  k: string;
  count: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * GetPatientFunnelUseCase — agrega a conversão do funil de PACIENTES por
 * país e período (Fase 4).
 *
 * READ-ONLY: apenas COUNT/GROUP BY sobre tabelas existentes (patients,
 * patient_status_history, admission_appointments, job_postings). Nunca toca
 * colunas de PII. A saída é validada pelo Zod antes de retornar.
 *
 * Escolha do `admision` (chegaram a ADMISSION+): contamos um paciente do
 * período se o STATUS ATUAL está em (ADMISSION, PENDING_ADMISSION, ACTIVE) OU
 * se EXISTE uma linha de histórico com new_value nesses valores. O "OU" cobre
 * os dois casos: (a) quem avançou e depois voltou/saiu — o status atual não
 * mostra mais, mas o histórico sim; (b) legado sem transição registrada — o
 * backfill (migration 254) só grava o status atual, então o current-status
 * garante que ele conte. SUSPENDED/DISCONTINUED/DISCHARGED ficam de fora
 * (não são "avanço" no funil de admissão).
 */
export class GetPatientFunnelUseCase {
  constructor(private readonly db: Pool) {}

  /**
   * @param query.countries escopo de país já resolvido (PR-9, `lex` #9,
   *   `resolveCountryScope`) — nunca vazio; substitui o antigo `country`
   *   escalar (undefined = "sem filtro", o vazamento cross-país medido).
   */
  async execute(query: PatientFunnelQuery & { countries: CountryCode[] }): Promise<PatientFunnelData> {
    const { countries } = query;
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - THIRTY_DAYS_MS);

    // Params posicionais compartilhados: $1 from, $2 to, $3 países (array — nunca "todos").
    const p = [from.toISOString(), to.toISOString(), countries];

    const [solRow, admRow, ageRow, vacRow, statusRows] = await Promise.all([
      // solicitantes — pacientes criados no período (todos os origins).
      this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM patients p
          WHERE p.deleted_at IS NULL
            AND p.created_at >= $1 AND p.created_at < $2
            AND p.country = ANY($3::bpchar[])`,
        p,
      ),
      // admision — distintos criados no período que chegaram a ADMISSION+.
      this.db.query<{ n: number }>(
        `SELECT COUNT(DISTINCT p.id)::int AS n
           FROM patients p
          WHERE p.deleted_at IS NULL
            AND p.created_at >= $1 AND p.created_at < $2
            AND p.country = ANY($3::bpchar[])
            AND (
              p.status IN ('ADMISSION', 'PENDING_ADMISSION', 'ACTIVE')
              OR EXISTS (
                SELECT 1 FROM patient_status_history psh
                 WHERE psh.patient_id = p.id
                   AND psh.new_value IN ('ADMISSION', 'PENDING_ADMISSION', 'ACTIVE')
              )
            )`,
        p,
      ),
      // agendadas — distintos patient_id com entrevista agendada no período.
      this.db.query<{ n: number }>(
        `SELECT COUNT(DISTINCT aa.patient_id)::int AS n
           FROM admission_appointments aa
          WHERE aa.patient_id IS NOT NULL
            AND aa.created_at >= $1 AND aa.created_at < $2
            AND aa.country = ANY($3::bpchar[])`,
        p,
      ),
      // vacantes — distintos patient_id com vaga (não-draft/não-deletada) de
      // paciente criado no período.
      this.db.query<{ n: number }>(
        `SELECT COUNT(DISTINCT jp.patient_id)::int AS n
           FROM job_postings jp
           JOIN patients p ON p.id = jp.patient_id
          WHERE jp.deleted_at IS NULL
            AND jp.is_draft = false
            AND jp.patient_id IS NOT NULL
            AND p.deleted_at IS NULL
            AND p.created_at >= $1 AND p.created_at < $2
            AND p.country = ANY($3::bpchar[])`,
        p,
      ),
      // byStatus — snapshot atual por status (para as colunas do kanban),
      // não escopado por período; respeita o país.
      this.db.query<CountRow>(
        `SELECT status AS k, COUNT(*)::int AS count
           FROM patients
          WHERE deleted_at IS NULL
            AND status IS NOT NULL
            AND country = ANY($1::bpchar[])
          GROUP BY status`,
        [countries],
      ),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusRows.rows) {
      if (row.k != null) byStatus[row.k] = row.count;
    }

    const data: PatientFunnelData = {
      period: { from: from.toISOString(), to: to.toISOString() },
      // Mantém a forma escalar do contrato de saída (não tocado, per escopo do
      // pedido): um país só ecoa ele; escopo multi-país (ALL) ecoa null — o
      // mesmo "não sei dizer um só" que o campo já usava para "sem filtro".
      country: countries.length === 1 ? countries[0] : null,
      solicitantes: solRow.rows[0]?.n ?? 0,
      admision: admRow.rows[0]?.n ?? 0,
      agendadas: ageRow.rows[0]?.n ?? 0,
      vacantes: vacRow.rows[0]?.n ?? 0,
      byStatus,
    };

    return patientFunnelSchema.parse(data);
  }
}
