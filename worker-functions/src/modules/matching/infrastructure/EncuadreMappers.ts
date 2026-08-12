import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { Encuadre, EncuadreFilters } from '../domain/Encuadre';

export async function mapEncuadreRow(
  row: Record<string, unknown>,
  encryptionService: KMSEncryptionService,
): Promise<Encuadre> {
  const workerEmail = await encryptionService.decrypt(
    row.worker_email_encrypted as string | null,
  );

  return {
    id: row.id as string,
    workerId: row.worker_id as string | null,
    jobPostingId: row.job_posting_id as string | null,
    workerRawName: row.worker_raw_name as string | null,
    workerRawPhone: row.worker_raw_phone as string | null,
    occupationRaw: row.occupation_raw as string | null,
    recruiterName: row.recruiter_name as string | null,
    coordinatorName: row.coordinator_name as string | null,
    recruitmentDate: row.recruitment_date ? new Date(row.recruitment_date as string) : null,
    interviewDate: row.interview_date ? new Date(row.interview_date as string) : null,
    interviewTime: row.interview_time as string | null,
    meetLink: row.meet_link as string | null,
    attended: row.attended as boolean | null,
    absenceReason: row.absence_reason as string | null,
    acceptsCase: row.accepts_case as 'Si' | 'No' | 'A confirmar' | null,
    rejectionReason: row.rejection_reason as string | null,
    rejectionReasonCategory: row.rejection_reason_category as Encuadre['rejectionReasonCategory'],
    resultado: row.resultado as Encuadre['resultado'],
    role: (row.role as Encuadre['role']) ?? null,
    redireccionamiento: row.redireccionamiento as string | null,
    hasCv: row.has_cv as boolean | null,
    hasDni: row.has_dni as boolean | null,
    hasCertAt: row.has_cert_at as boolean | null,
    hasAfip: row.has_afip as boolean | null,
    hasCbu: row.has_cbu as boolean | null,
    hasAp: row.has_ap as boolean | null,
    hasSeguros: row.has_seguros as boolean | null,
    workerEmail: workerEmail || null,
    obsReclutamiento: row.obs_reclutamiento as string | null,
    obsEncuadre: row.obs_encuadre as string | null,
    obsAdicionales: row.obs_adicionales as string | null,
    importSourceAudit: row.import_source_audit as string | null,
    idOnboarding: row.id_onboarding as string | null,
    dedupHash: row.dedup_hash as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export function buildEncuadreWhereClause(filters: EncuadreFilters): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.workerId)     { conditions.push(`worker_id = $${idx++}`);     values.push(filters.workerId); }
  if (filters.jobPostingId) { conditions.push(`job_posting_id = $${idx++}`); values.push(filters.jobPostingId); }
  if (filters.resultado)    { conditions.push(`resultado = $${idx++}`);      values.push(filters.resultado); }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}
