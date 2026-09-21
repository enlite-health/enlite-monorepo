import { Request, Response } from 'express';
import { z } from 'zod';
import {
  UpdateWorkerProfileFieldsUseCase,
  WorkerNotFoundError,
  type WorkerProfilePatch,
} from '../../application/UpdateWorkerProfileFieldsUseCase';
import { logger, reportError } from '@shared/logging';
import { WorkerAuditRepository, extractWorkerAuditActor } from '../../infrastructure/WorkerAuditRepository';
import { PubSubClient } from '@shared/events/PubSubClient';
import { cellsOfRequest } from '@modules/identity/permissions';
import { WORKER_PII_WRITE_CELL, canWriteWorkerPii } from '../../application/workerContainerAccess';
import { isValidIsoBirthDate } from '@shared/utils/isValidIsoBirthDate';

/**
 * AdminWorkerProfileController
 *
 * Edição administrativa do perfil de um worker. Apenas role ADMIN
 * (gate aplicado pelo middleware na rota, não aqui).
 *
 * Rota (registrada em src/index.ts, `worker:write`; papel `admin` só até a família virar):
 *   PATCH /api/admin/workers/:id/profile
 *
 * Body: subconjunto da whitelist abaixo (partial update). Pelo menos um
 * campo é obrigatório. Reusa UpdateWorkerProfileFieldsUseCase (mesmo use
 * case do canal MCP de triagem).
 */

const CANONICAL_DOCUMENT_TYPES = ['DNI', 'PASSPORT', 'CEDULA', 'LE_LC', 'CPF'] as const;
const CANONICAL_PROFESSIONS = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;

// Endereço NÃO entra aqui — é editado via PUT /api/admin/workers/:id/service-area
// (integração Google Places + lat/lng), ver AdminWorkerServiceAreaController.
const UpdateProfileBodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(255).optional(),
    lastName: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().email().max(255).optional(),
    documentType: z.enum(CANONICAL_DOCUMENT_TYPES).optional(),
    documentNumber: z.string().trim().min(1).max(64).optional(),
    profession: z.enum(CANONICAL_PROFESSIONS).optional(),
    // ── Professional data ──
    occupation: z.enum(CANONICAL_PROFESSIONS).optional(), // workers.occupation: enum alinhado a profession (mig 076)
    knowledgeLevel: z.string().trim().max(40).optional(),
    titleCertificate: z.string().trim().max(80).optional(),
    yearsExperience: z.string().trim().max(20).optional(),
    experienceTypes: z.array(z.string().trim().max(60)).max(20).optional(),
    preferredTypes: z.array(z.string().trim().max(60)).max(20).optional(),
    preferredAgeRange: z.array(z.string().trim().max(40)).max(10).optional(),
    languages: z.array(z.string().trim().max(10)).max(10).optional(),
    linkedinUrl: z.string().trim().max(255).optional(),
    // Spec 025 (Fase 6, D402 item 4): dossiê — gated por `worker_pii:write`, conferido abaixo
    // (célula cumulativa a `worker:update`, não faz parte do body schema em si). Calendário real
    // (mesma validação de `SavePersonalInfoUseCase`), não só regex — achado F3 do
    // `WorkerProfileUpdateCapability` é exatamente regex sem validação de calendário.
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidIsoBirthDate, {
      message: 'Invalid birth date',
    }).optional(),
  })
  .strict()
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'At least one field must be provided' },
  );

function getUid(req: Request): string | null {
  return (req as Request & { user?: { uid: string } }).user?.uid ?? null;
}

export class AdminWorkerProfileController {
  private readonly useCase: UpdateWorkerProfileFieldsUseCase;
  private readonly auditRepo: WorkerAuditRepository;

  constructor() {
    this.useCase = new UpdateWorkerProfileFieldsUseCase(new PubSubClient());
    this.auditRepo = new WorkerAuditRepository();
  }

  /** PATCH /api/admin/workers/:id/profile */
  async updateProfile(req: Request, res: Response): Promise<void> {
    const uid = getUid(req);
    if (!uid) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { id } = req.params;
    const parsed = UpdateProfileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    // Spec 025 (Fase 6): `birthDate` é dossiê — célula CUMULATIVA a `worker:update` (mesmo
    // mecanismo de `patient_clinical:write` em AdminTherapeuticProjectsController), conferida
    // aqui porque o campo sensível viaja dentro do PATCH de outro recurso. Sem a célula, 403 com
    // a célula NOMEADA e o valor nunca ecoado (nem no corpo nem em log).
    if (parsed.data.birthDate !== undefined) {
      const cells = cellsOfRequest(req);
      if (!canWriteWorkerPii(cells)) {
        res.status(403).json({ success: false, error: 'Forbidden', details: { cell: WORKER_PII_WRITE_CELL } });
        return;
      }
    }

    const patch: WorkerProfilePatch = { workerId: id, ...parsed.data };

    try {
      const result = await this.useCase.execute(patch, {
        source: 'admin_panel',
        actorUid: uid,
      });
      logger.info({ msg: 'worker profile updated by admin', workerId: id, uid, fieldsUpdated: result.fieldsUpdated });
      // Trilho de auditoria detalhado (quem/o-quê/quando/de-onde) — best-effort.
      await this.auditRepo.recordFieldChanges({
        workerId: id,
        fields: result.changes,
        actor: extractWorkerAuditActor(req),
      });
      res.status(200).json({ success: true, data: { workerId: result.workerId, fieldsUpdated: result.fieldsUpdated } });
    } catch (err) {
      if (err instanceof WorkerNotFoundError) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminWorkerProfileController:updateProfile', workerId: id, uid });
      res.status(500).json({ success: false, error: 'Failed to update worker profile' });
    }
  }
}
