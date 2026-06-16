import { Pool } from 'pg';
import {
  WorkerDocuments,
  CreateWorkerDocumentsDTO,
  UpdateWorkerDocumentsDTO,
  ReviewWorkerDocumentsDTO,
  DocumentsStatus,
  DocumentValidations,
} from '../domain/WorkerDocuments';
import { getRequiredCamelFields } from '../application/workerDocumentPolicy';
import { logger } from '@shared/logging';

export interface IWorkerDocumentsRepository {
  create(dto: CreateWorkerDocumentsDTO): Promise<WorkerDocuments>;
  findByWorkerId(workerId: string): Promise<WorkerDocuments | null>;
  update(dto: UpdateWorkerDocumentsDTO): Promise<WorkerDocuments>;
  review(dto: ReviewWorkerDocumentsDTO): Promise<WorkerDocuments>;
  delete(workerId: string): Promise<void>;
  clearDocumentField(workerId: string, columnName: string, docTypeSlug?: string): Promise<void>;
  validateDocument(workerId: string, docType: string, adminEmail: string): Promise<WorkerDocuments>;
  clearDocumentValidation(workerId: string, docType: string): Promise<WorkerDocuments>;
}

export class WorkerDocumentsRepository implements IWorkerDocumentsRepository {
  constructor(private pool: Pool) {}

  async create(dto: CreateWorkerDocumentsDTO): Promise<WorkerDocuments> {
    const profession = await this.getWorkerProfession(dto.workerId);
    const status = this.computeStatus(dto as unknown as Record<string, unknown>, profession);
    const log = logger.child({ workerId: dto.workerId });
    log.info({ msg: '[WorkerDocumentsRepo.create] status computed', status, profession });

    const query = `
      INSERT INTO worker_documents (
        worker_id,
        resume_cv_url, identity_document_url, identity_document_back_url,
        criminal_record_url, professional_registration_url, liability_insurance_url,
        monotributo_certificate_url, at_certificate_url,
        apto_psicofisico_url, analitico_universitario_url, carta_recomendacion_url,
        additional_certificates_urls, documents_status, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const values = [
      dto.workerId,
      dto.resumeCvUrl ?? null,
      dto.identityDocumentUrl ?? null,
      dto.identityDocumentBackUrl ?? null,
      dto.criminalRecordUrl ?? null,
      dto.professionalRegistrationUrl ?? null,
      dto.liabilityInsuranceUrl ?? null,
      dto.monotributoCertificateUrl ?? null,
      dto.atCertificateUrl ?? null,
      dto.aptoPsicofisicoUrl ?? null,
      dto.analiticoUniversitarioUrl ?? null,
      dto.cartaRecomendacionUrl ?? null,
      dto.additionalCertificatesUrls ?? [],
      status,
      status === 'submitted' ? new Date() : null,
    ];

    const result = await this.pool.query(query, values);
    log.info({ msg: '[WorkerDocumentsRepo.create] SUCCESS', id: result.rows[0]?.id });
    return this.mapToEntity(result.rows[0]);
  }

  async findByWorkerId(workerId: string): Promise<WorkerDocuments | null> {
    const log = logger.child({ workerId });
    log.info({ msg: '[WorkerDocumentsRepo.findByWorkerId]' });
    const query = 'SELECT * FROM worker_documents WHERE worker_id = $1';
    const result = await this.pool.query(query, [workerId]);

    if (result.rows.length === 0) {
      log.info({ msg: '[WorkerDocumentsRepo.findByWorkerId] not found' });
      return null;
    }

    log.info({ msg: '[WorkerDocumentsRepo.findByWorkerId] found', status: result.rows[0].documents_status });
    return this.mapToEntity(result.rows[0]);
  }

  async update(dto: UpdateWorkerDocumentsDTO): Promise<WorkerDocuments> {
    const log = logger.child({ workerId: dto.workerId });
    log.info({ msg: '[WorkerDocumentsRepo.update]' });
    const existing = await this.findByWorkerId(dto.workerId);
    if (!existing) {
      throw new Error('Worker documents not found');
    }

    const profession = await this.getWorkerProfession(dto.workerId);
    const merged = this.mergeForStatus(dto, existing);
    const newStatus = dto.documentsStatus ?? this.computeStatus(merged, profession);
    const isResubmission = existing.documentsStatus === 'rejected' && newStatus === 'submitted';

    // Map camelCase DTO fields → slug keys used in document_validations JSONB
    const docFieldToSlug: Array<{ field: keyof UpdateWorkerDocumentsDTO; slug: string }> = [
      { field: 'resumeCvUrl',                  slug: 'resume_cv' },
      { field: 'identityDocumentUrl',           slug: 'identity_document' },
      { field: 'identityDocumentBackUrl',       slug: 'identity_document_back' },
      { field: 'criminalRecordUrl',             slug: 'criminal_record' },
      { field: 'professionalRegistrationUrl',   slug: 'professional_registration' },
      { field: 'liabilityInsuranceUrl',         slug: 'liability_insurance' },
      { field: 'monotributoCertificateUrl',     slug: 'monotributo_certificate' },
      { field: 'atCertificateUrl',              slug: 'at_certificate' },
      { field: 'aptoPsicofisicoUrl',            slug: 'apto_psicofisico' },
      { field: 'analiticoUniversitarioUrl',     slug: 'analitico_universitario' },
      { field: 'cartaRecomendacionUrl',         slug: 'carta_recomendacion' },
    ];
    const reuploaded = docFieldToSlug
      .filter(({ field }) => dto[field] != null)
      .map(({ slug }) => slug);

    log.info({
      msg: '[WorkerDocumentsRepo.update] computed',
      newStatus,
      profession,
      isResubmission,
      clearingValidations: reuploaded,
    });

    // Build JSONB expression removing validation entries for re-uploaded docs
    const validationExpr = reuploaded.length > 0
      ? `document_validations - ARRAY[${reuploaded.map((s) => `'${s}'`).join(', ')}]::text[]`
      : 'document_validations';

    const query = `
      UPDATE worker_documents
      SET
        resume_cv_url                = COALESCE($2,  resume_cv_url),
        identity_document_url        = COALESCE($3,  identity_document_url),
        identity_document_back_url   = COALESCE($4,  identity_document_back_url),
        criminal_record_url          = COALESCE($5,  criminal_record_url),
        professional_registration_url= COALESCE($6,  professional_registration_url),
        liability_insurance_url      = COALESCE($7,  liability_insurance_url),
        monotributo_certificate_url  = COALESCE($8,  monotributo_certificate_url),
        at_certificate_url           = COALESCE($9,  at_certificate_url),
        apto_psicofisico_url         = COALESCE($10, apto_psicofisico_url),
        analitico_universitario_url  = COALESCE($11, analitico_universitario_url),
        carta_recomendacion_url      = COALESCE($12, carta_recomendacion_url),
        additional_certificates_urls = COALESCE($13, additional_certificates_urls),
        documents_status             = $14,
        document_validations         = ${validationExpr},
        resubmitted_at               = CASE WHEN $15 THEN NOW() ELSE resubmitted_at END,
        updated_at                   = NOW()
      WHERE worker_id = $1
      RETURNING *
    `;

    const values = [
      dto.workerId,
      dto.resumeCvUrl,
      dto.identityDocumentUrl,
      dto.identityDocumentBackUrl,
      dto.criminalRecordUrl,
      dto.professionalRegistrationUrl,
      dto.liabilityInsuranceUrl,
      dto.monotributoCertificateUrl,
      dto.atCertificateUrl,
      dto.aptoPsicofisicoUrl,
      dto.analiticoUniversitarioUrl,
      dto.cartaRecomendacionUrl,
      dto.additionalCertificatesUrls,
      newStatus,
      isResubmission,
    ];

    const result = await this.pool.query(query, values);
    log.info({ msg: '[WorkerDocumentsRepo.update] SUCCESS', finalStatus: result.rows[0]?.documents_status });
    return this.mapToEntity(result.rows[0]);
  }

  async review(dto: ReviewWorkerDocumentsDTO): Promise<WorkerDocuments> {
    const log = logger.child({ workerId: dto.workerId });
    log.info({ msg: '[WorkerDocumentsRepo.review]', newStatus: dto.documentsStatus });

    const query = `
      UPDATE worker_documents
      SET
        documents_status = $2,
        review_notes     = $3,
        reviewed_by      = $4,
        reviewed_at      = NOW(),
        updated_at       = NOW()
      WHERE worker_id = $1
      RETURNING *
    `;

    const values = [dto.workerId, dto.documentsStatus, dto.reviewNotes ?? null, dto.reviewedBy];
    const result = await this.pool.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Worker documents not found');
    }

    log.info({ msg: '[WorkerDocumentsRepo.review] SUCCESS', finalStatus: result.rows[0].documents_status });
    return this.mapToEntity(result.rows[0]);
  }

  async delete(workerId: string): Promise<void> {
    logger.child({ workerId }).info({ msg: '[WorkerDocumentsRepo.delete]' });
    await this.pool.query('DELETE FROM worker_documents WHERE worker_id = $1', [workerId]);
  }

  async clearDocumentField(workerId: string, columnName: string, docTypeSlug?: string): Promise<void> {
    const log = logger.child({ workerId });
    log.info({ msg: '[WorkerDocumentsRepo.clearDocumentField]', columnName, docTypeSlug });

    const allowed = [
      'resume_cv_url',
      'identity_document_url',
      'identity_document_back_url',
      'criminal_record_url',
      'professional_registration_url',
      'liability_insurance_url',
      'monotributo_certificate_url',
      'at_certificate_url',
      'apto_psicofisico_url',
      'analitico_universitario_url',
      'carta_recomendacion_url',
    ];
    if (!allowed.includes(columnName)) throw new Error(`Invalid column: ${columnName}`);

    if (docTypeSlug) {
      await this.pool.query(
        `UPDATE worker_documents
         SET ${columnName} = NULL,
             document_validations = document_validations - $2,
             updated_at = NOW()
         WHERE worker_id = $1`,
        [workerId, docTypeSlug],
      );
    } else {
      await this.pool.query(
        `UPDATE worker_documents SET ${columnName} = NULL, updated_at = NOW() WHERE worker_id = $1`,
        [workerId],
      );
    }
  }

  async validateDocument(workerId: string, docType: string, adminEmail: string): Promise<WorkerDocuments> {
    const log = logger.child({ workerId });
    log.info({ msg: '[WorkerDocumentsRepo.validateDocument]', docType, adminEmail });
    const query = `
      UPDATE worker_documents
      SET document_validations = document_validations || jsonb_build_object(
            $2::text, jsonb_build_object('validated_by', $3::text, 'validated_at', NOW()::text)
          ),
          updated_at = NOW()
      WHERE worker_id = $1
      RETURNING *
    `;
    const result = await this.pool.query(query, [workerId, docType, adminEmail]);
    if (result.rows.length === 0) throw new Error('Worker documents not found');
    log.info({ msg: '[WorkerDocumentsRepo.validateDocument] SUCCESS', docType });
    return this.mapToEntity(result.rows[0]);
  }

  async clearDocumentValidation(workerId: string, docType: string): Promise<WorkerDocuments> {
    const log = logger.child({ workerId });
    log.info({ msg: '[WorkerDocumentsRepo.clearDocumentValidation]', docType });
    const result = await this.pool.query(
      `UPDATE worker_documents
       SET document_validations = document_validations - $2,
           updated_at = NOW()
       WHERE worker_id = $1
       RETURNING *`,
      [workerId, docType],
    );
    if (result.rows.length === 0) throw new Error('Worker documents not found');
    return this.mapToEntity(result.rows[0]);
  }

  /** Convert snake_case JSONB map from DB into camelCase DocumentValidations. */
  private mapDocumentValidations(
    raw: Record<string, { validated_by: string; validated_at: string }> | null,
  ): DocumentValidations {
    if (!raw) return {};
    const result: DocumentValidations = {};
    for (const [key, val] of Object.entries(raw)) {
      result[key as keyof DocumentValidations] = {
        validatedBy: val.validated_by,
        validatedAt: val.validated_at,
      };
    }
    return result;
  }

  private mapToEntity(row: Record<string, unknown>): WorkerDocuments {
    return {
      id: row.id as string,
      workerId: row.worker_id as string,
      resumeCvUrl: row.resume_cv_url as string | undefined,
      identityDocumentUrl: row.identity_document_url as string | undefined,
      identityDocumentBackUrl: row.identity_document_back_url as string | undefined,
      criminalRecordUrl: row.criminal_record_url as string | undefined,
      professionalRegistrationUrl: row.professional_registration_url as string | undefined,
      liabilityInsuranceUrl: row.liability_insurance_url as string | undefined,
      monotributoCertificateUrl: row.monotributo_certificate_url as string | undefined,
      atCertificateUrl: row.at_certificate_url as string | undefined,
      aptoPsicofisicoUrl: row.apto_psicofisico_url as string | undefined,
      analiticoUniversitarioUrl: row.analitico_universitario_url as string | undefined,
      cartaRecomendacionUrl: row.carta_recomendacion_url as string | undefined,
      additionalCertificatesUrls: (row.additional_certificates_urls as string[]) || [],
      documentsStatus: row.documents_status as DocumentsStatus,
      documentValidations: this.mapDocumentValidations(
        row.document_validations as Record<string, { validated_by: string; validated_at: string }> | null,
      ),
      reviewNotes: row.review_notes as string | undefined,
      reviewedBy: row.reviewed_by as string | undefined,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at as string) : undefined,
      submittedAt: row.submitted_at ? new Date(row.submitted_at as string) : undefined,
      resubmittedAt: row.resubmitted_at ? new Date(row.resubmitted_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private async getWorkerProfession(workerId: string): Promise<string | null> {
    const result = await this.pool.query<{ profession: string | null }>(
      'SELECT profession FROM workers WHERE id = $1',
      [workerId],
    );
    return result.rows[0]?.profession ?? null;
  }

  /**
   * Compute documents_status based on which required fields are filled.
   *
   * Uses workerDocumentPolicy.getRequiredCamelFields as single source of truth.
   *
   * Status semantics:
   *   pending    → 0 required fields filled
   *   incomplete → at least 1 but not all required fields filled
   *   submitted  → all required fields present
   */
  private computeStatus(
    docs: Record<string, unknown>,
    profession: string | null,
  ): DocumentsStatus {
    const required = getRequiredCamelFields(profession);
    const filled = required.filter((field) => !!docs[field]).length;

    if (filled === 0) return 'pending';
    if (filled < required.length) return 'incomplete';
    return 'submitted';
  }

  /** Merge DTO over existing entity to produce a unified record for status computation. */
  private mergeForStatus(
    dto: UpdateWorkerDocumentsDTO,
    existing: WorkerDocuments,
  ): Record<string, string | undefined> {
    return {
      resumeCvUrl:                dto.resumeCvUrl                ?? existing.resumeCvUrl,
      identityDocumentUrl:        dto.identityDocumentUrl        ?? existing.identityDocumentUrl,
      identityDocumentBackUrl:    dto.identityDocumentBackUrl    ?? existing.identityDocumentBackUrl,
      criminalRecordUrl:          dto.criminalRecordUrl          ?? existing.criminalRecordUrl,
      professionalRegistrationUrl:dto.professionalRegistrationUrl?? existing.professionalRegistrationUrl,
      liabilityInsuranceUrl:      dto.liabilityInsuranceUrl      ?? existing.liabilityInsuranceUrl,
      monotributoCertificateUrl:  dto.monotributoCertificateUrl  ?? existing.monotributoCertificateUrl,
      atCertificateUrl:           dto.atCertificateUrl           ?? existing.atCertificateUrl,
      aptoPsicofisicoUrl:         dto.aptoPsicofisicoUrl         ?? existing.aptoPsicofisicoUrl,
      analiticoUniversitarioUrl:  dto.analiticoUniversitarioUrl  ?? existing.analiticoUniversitarioUrl,
      cartaRecomendacionUrl:      dto.cartaRecomendacionUrl      ?? existing.cartaRecomendacionUrl,
    };
  }
}
