/**
 * Monta as variáveis para os templates `ar_vacancy_match_complete` e
 * `ar_vacancy_match_incomplete`. Compartilhado entre:
 *   - VacancyAutoInviteHandler (disparo automático via outbox, com tokenização PII)
 *   - MessagingController (envio manual + preview, com PII plaintext)
 *
 * Critério: `worker_name`, `patient_zone`, `vacancy_url` para o _complete;
 * mais `pending_documents` para o _incomplete.
 *
 * URL base é a mesma usada pelo handler automático
 * (https://app.enlite.health/vacancies/<jobPostingId>) — manter sincronizado.
 */
import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { formatPendingDocuments } from '@shared/events/handlers/VacancyAutoInviteHandler';

const VACANCY_URL_BASE = 'https://app.enlite.health/vacancies';

export interface VacancyMatchVariables {
  worker_name: string;
  patient_zone: string;
  vacancy_url: string;
  pending_documents?: string;
}

export class BuildVacancyMatchVariablesUseCase {
  constructor(
    private readonly db: Pool,
    private readonly kms: KMSEncryptionService,
  ) {}

  async execute(
    workerId: string,
    jobPostingId: string,
    templateSlug: string,
  ): Promise<VacancyMatchVariables> {
    const [workerName, patientZone] = await Promise.all([
      this.fetchWorkerFirstName(workerId),
      this.fetchPatientZone(jobPostingId),
    ]);

    const baseVars: VacancyMatchVariables = {
      worker_name: workerName,
      patient_zone: patientZone,
      vacancy_url: `${VACANCY_URL_BASE}/${jobPostingId}`,
    };

    if (templateSlug === 'ar_vacancy_match_incomplete') {
      baseVars.pending_documents = await formatPendingDocuments(this.db, workerId);
    }

    return baseVars;
  }

  private async fetchWorkerFirstName(workerId: string): Promise<string> {
    const res = await this.db.query<{ first_name_encrypted: string | null }>(
      `SELECT first_name_encrypted FROM workers WHERE id = $1 LIMIT 1`,
      [workerId],
    );
    const enc = res.rows[0]?.first_name_encrypted;
    if (!enc) return '';
    return (await this.kms.decrypt(enc)) ?? '';
  }

  private async fetchPatientZone(jobPostingId: string): Promise<string> {
    const res = await this.db.query<{ patient_zone: string | null }>(
      `SELECT patient_zone FROM job_postings WHERE id = $1 LIMIT 1`,
      [jobPostingId],
    );
    return res.rows[0]?.patient_zone ?? '';
  }
}

/** Renderiza placeholders nomeados `{{key}}` no body usando o mapa de variables. */
export function renderTemplateBody(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
