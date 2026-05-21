import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  Encuadre,
  EncuadreFilters,
  SupplementEncuadreDTO,
} from '../domain/Encuadre';
import { mapEncuadreRow, buildEncuadreWhereClause } from './EncuadreMappers';

/**
 * EncuadreQueryRepository
 *
 * Métodos de consulta, atualização e contagem de encuadres.
 * Extraído de EncuadreRepository para respeitar o limite de 400 linhas.
 */
export class EncuadreQueryRepository {
  protected pool: Pool;
  protected encryptionService: KMSEncryptionService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  async findSoftMatch(
    jobPostingId: string,
    phone: string,
    interviewDate: Date | null,
    recruitmentDate: Date | null,
  ): Promise<Encuadre | null> {
    const conditions: string[] = ['job_posting_id = $1', 'worker_raw_phone = $2'];
    const values: unknown[] = [jobPostingId, phone];
    let idx = 3;

    if (interviewDate) {
      conditions.push(`interview_date = $${idx++}`);
      values.push(interviewDate.toISOString().split('T')[0]);
    }
    if (recruitmentDate) {
      conditions.push(`recruitment_date = $${idx++}`);
      values.push(recruitmentDate.toISOString().split('T')[0]);
    }

    const result = await this.pool.query(
      `SELECT * FROM encuadres WHERE ${conditions.join(' AND ')} LIMIT 1`,
      values,
    );
    return result.rows[0] ? mapEncuadreRow(result.rows[0], this.encryptionService) : null;
  }

  async updateSupplement(id: string, dto: SupplementEncuadreDTO): Promise<void> {
    const workerEmailEnc = await this.encryptionService.encrypt(dto.workerEmail ?? null);

    await this.pool.query(
      `UPDATE encuadres SET
        interview_time    = COALESCE(interview_time,    $2),
        meet_link         = COALESCE(meet_link,         $3),
        origen            = COALESCE(origen,            $4),
        id_onboarding     = COALESCE(id_onboarding,     $5),
        resultado         = COALESCE(resultado,         $6),
        has_cv            = COALESCE(has_cv,            $7),
        has_dni           = COALESCE(has_dni,           $8),
        has_cert_at       = COALESCE(has_cert_at,       $9),
        has_afip          = COALESCE(has_afip,          $10),
        has_cbu           = COALESCE(has_cbu,           $11),
        has_ap            = COALESCE(has_ap,            $12),
        has_seguros       = COALESCE(has_seguros,       $13),
        worker_email_encrypted = COALESCE(worker_email_encrypted, $14),
        obs_encuadre      = COALESCE(obs_encuadre,      $15),
        obs_adicionales   = COALESCE(obs_adicionales,   $16),
        absence_reason    = COALESCE(absence_reason,    $17),
        rejection_reason  = COALESCE(rejection_reason,  $18),
        rejection_reason_category = COALESCE(rejection_reason_category, $19),
        redireccionamiento= COALESCE(redireccionamiento,$20),
        updated_at        = NOW()
       WHERE id = $1`,
      [
        id,
        dto.interviewTime ?? null, dto.meetLink ?? null, dto.origen ?? null,
        dto.idOnboarding ?? null, dto.resultado ?? null,
        dto.hasCv ?? null, dto.hasDni ?? null, dto.hasCertAt ?? null,
        dto.hasAfip ?? null, dto.hasCbu ?? null, dto.hasAp ?? null, dto.hasSeguros ?? null,
        workerEmailEnc, dto.obsEncuadre ?? null, dto.obsAdicionales ?? null,
        dto.absenceReason ?? null, dto.rejectionReason ?? null,
        dto.rejectionReasonCategory ?? null, dto.redireccionamiento ?? null,
      ],
    );
  }

  async findByDedupHash(hash: string): Promise<Encuadre | null> {
    const result = await this.pool.query(
      'SELECT * FROM encuadres WHERE dedup_hash = $1',
      [hash],
    );
    return result.rows[0] ? mapEncuadreRow(result.rows[0], this.encryptionService) : null;
  }

  async findByWorkerId(workerId: string): Promise<Encuadre[]> {
    const result = await this.pool.query(
      `SELECT e.*, jp.case_number, jp.vacancy_number, p.first_name AS patient_name
       FROM encuadres e
       LEFT JOIN job_postings jp ON jp.id = e.job_posting_id AND jp.deleted_at IS NULL
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE e.worker_id = $1
       ORDER BY e.interview_date DESC NULLS LAST, e.created_at DESC`,
      [workerId],
    );
    return Promise.all(result.rows.map(r => mapEncuadreRow(r, this.encryptionService)));
  }

  async findByJobPostingId(jobPostingId: string): Promise<Encuadre[]> {
    const result = await this.pool.query(
      `SELECT e.*, w.phone as worker_phone
       FROM encuadres e
       LEFT JOIN workers w ON w.id = e.worker_id
       WHERE e.job_posting_id = $1
       ORDER BY e.interview_date DESC NULLS LAST, e.created_at DESC`,
      [jobPostingId],
    );
    return Promise.all(result.rows.map(r => mapEncuadreRow(r, this.encryptionService)));
  }

  async linkWorkersByPhone(): Promise<number> {
    const result = await this.pool.query(`
      UPDATE encuadres e
      SET worker_id = w.id
      FROM workers w
      WHERE e.worker_id IS NULL
        AND e.worker_raw_phone IS NOT NULL
        AND w.phone = e.worker_raw_phone
    `);
    return result.rowCount ?? 0;
  }

  async countByFilters(filters: EncuadreFilters): Promise<number> {
    const { where, values } = buildEncuadreWhereClause(filters);
    const result = await this.pool.query(`SELECT COUNT(*) FROM encuadres ${where}`, values);
    return parseInt(result.rows[0].count);
  }

  async countAttended(filters: { startDate?: string; endDate?: string; country?: string } = {}): Promise<number> {
    const conditions: string[] = ['e.attended = true'];
    const values: unknown[] = [];
    let idx = 1;

    if (filters.startDate) { conditions.push(`e.interview_date >= $${idx++}`); values.push(filters.startDate); }
    if (filters.endDate)   { conditions.push(`e.interview_date <= $${idx++}`); values.push(filters.endDate); }
    if (filters.country)   { conditions.push(`jp.country = $${idx++}`); values.push(filters.country); }

    const joinClause = filters.country
      ? 'LEFT JOIN job_postings jp ON e.job_posting_id = jp.id AND jp.deleted_at IS NULL'
      : '';

    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM encuadres e ${joinClause} WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return (result.rows[0]?.count as number) ?? 0;
  }

  async countCandidatesByJobPosting(jobPostingId: string, filters: { startDate?: string; endDate?: string } = {}): Promise<number> {
    const conditions: string[] = [
      'job_posting_id = $1',
      "resultado NOT IN ('RECHAZADO', 'BLACKLIST') OR resultado IS NULL",
    ];
    const values: unknown[] = [jobPostingId];
    let idx = 2;

    if (filters.startDate) { conditions.push(`interview_date >= $${idx++}`); values.push(filters.startDate); }
    if (filters.endDate)   { conditions.push(`interview_date <= $${idx++}`); values.push(filters.endDate); }

    const result = await this.pool.query(
      `SELECT COUNT(DISTINCT COALESCE(worker_id::text, worker_raw_phone))::int AS count FROM encuadres WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return (result.rows[0]?.count as number) ?? 0;
  }

  async countInvitedAndAttended(jobPostingId: string, filters: { startDate?: string; endDate?: string } = {}): Promise<{ invitados: number; asistentes: number }> {
    const conditions: string[] = ['job_posting_id = $1'];
    const values: unknown[] = [jobPostingId];
    let idx = 2;

    if (filters.startDate) { conditions.push(`interview_date >= $${idx++}`); values.push(filters.startDate); }
    if (filters.endDate)   { conditions.push(`interview_date <= $${idx++}`); values.push(filters.endDate); }

    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS invitados, COUNT(*) FILTER (WHERE attended = true)::int AS asistentes
       FROM encuadres WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return {
      invitados:  (result.rows[0]?.invitados  as number) ?? 0,
      asistentes: (result.rows[0]?.asistentes as number) ?? 0,
    };
  }

  async countByResultado(jobPostingId: string, filters: { startDate?: string; endDate?: string } = {}): Promise<Array<{ resultado: string; count: number }>> {
    const conditions: string[] = ['job_posting_id = $1', 'resultado IS NOT NULL'];
    const values: unknown[] = [jobPostingId];
    let idx = 2;

    if (filters.startDate) { conditions.push(`interview_date >= $${idx++}`); values.push(filters.startDate); }
    if (filters.endDate)   { conditions.push(`interview_date <= $${idx++}`); values.push(filters.endDate); }

    const result = await this.pool.query(
      `SELECT resultado, COUNT(*)::int AS count FROM encuadres WHERE ${conditions.join(' AND ')} GROUP BY resultado ORDER BY count DESC`,
      values,
    );
    return result.rows.map(r => ({ resultado: r.resultado as string, count: r.count as number }));
  }

  async countSelAndRemByCaseNumber(country: string = 'AR'): Promise<Record<string, { sel: number; rem: number }>> {
    const result = await this.pool.query(
      `SELECT jp.case_number,
              COUNT(*) FILTER (WHERE e.resultado = 'SELECCIONADO')::int AS sel,
              COUNT(*) FILTER (WHERE e.resultado IN ('REEMPLAZO'))::int AS rem
       FROM encuadres e
       JOIN job_postings jp ON e.job_posting_id = jp.id
       WHERE jp.country = $1 AND jp.deleted_at IS NULL
         AND e.resultado IN ('SELECCIONADO', 'REEMPLAZO')
       GROUP BY jp.case_number`,
      [country],
    );
    const map: Record<string, { sel: number; rem: number }> = {};
    for (const r of result.rows) {
      map[String(r.case_number)] = { sel: r.sel as number, rem: r.rem as number };
    }
    return map;
  }

  async getWorkerRejectionHistory(workerId: string): Promise<Record<string, number>> {
    const result = await this.pool.query(
      `SELECT rejection_reason_category, COUNT(*)::integer AS count
       FROM encuadres
       WHERE worker_id = $1 AND rejection_reason_category IS NOT NULL
       GROUP BY rejection_reason_category`,
      [workerId],
    );
    const history: Record<string, number> = {};
    for (const row of result.rows) {
      history[row.rejection_reason_category] = row.count;
    }
    return history;
  }
}
