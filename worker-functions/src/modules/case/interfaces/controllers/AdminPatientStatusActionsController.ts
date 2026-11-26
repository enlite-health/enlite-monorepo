import type { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { adminPatientParamsSchema } from '../validators/adminPatientParamsSchema';
import { patientStatusActionSchema } from '../validators/patientStatusActionSchemas';
import { respondPatientStatusError } from './patientStatusErrorResponse';
import { clinicalCellsOf, canReadPatientClinical, PATIENT_CLINICAL_READ_CELL } from '../../application/patientClinicalAccess';
import { exposeBlockingCodes } from '../../application/patientContainerAccess';
import type { PatientStatusActionUseCase } from '../../application/PatientStatusActionUseCase';
import type { ListPatientStatusActionsUseCase } from '../../application/ListPatientStatusActionsUseCase';
import type { Acao } from '../../domain/acoesDeEstado';
import type { OnHoldReason } from '../../domain/enums/OnHoldReason';
import type { SuspensionExitReason } from '../../domain/enums/SuspensionExitReason';
import { buildListPatientStatusActionsUseCase, buildPatientStatusActionUseCase } from '../composition/patientStatusActionComposition';
import { dispatchPatientTalentumPause } from './dispatchPatientTalentumPause';

/**
 * AdminPatientStatusActionsController — as ações dos estados humanos (estado-automatico-do-paciente, F3, D5/D9).
 *
 *   GET  /api/admin/patients/:id/status-actions  → o que o servidor aceitaria agora (mesma avaliação da escrita)
 *   POST /api/admin/patients/:id/status-actions  → { action, onHoldReason?, onHoldNote?, suspensionExitReason? }
 *
 * `patient:update`, a mesma célula do `PUT /status`. O erro vira HTTP na função única `respondPatientStatusError` (a mesma do PUT).
 * Só status, código e contagem na resposta e no log — `on_hold_note` (texto clínico restrito) nunca sai daqui.
 */
export class AdminPatientStatusActionsController {
  constructor(
    // Construídos sob demanda: o construtor não abre banco (molde dos outros controllers desta rota).
    private readonly applyUseCase: PatientStatusActionUseCase = buildPatientStatusActionUseCase(),
    private readonly listUseCase: ListPatientStatusActionsUseCase = buildListPatientStatusActionsUseCase(),
  ) {}

  /** GET /patients/:id/status-actions */
  async list(req: Request, res: Response): Promise<void> {
    const params = adminPatientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: params.error.flatten() });
      return;
    }
    try {
      const cells = clinicalCellsOf(req);
      const data = await this.listUseCase.execute({ patientId: params.data.id, cells });
      // `blockedBy` pode trazer `DIAGNOSIS`: sai como `CLINICAL_DATA` para quem não lê `patient_clinical`.
      const actions = data.actions.map((a) => (a.blockedBy ? { ...a, blockedBy: exposeBlockingCodes(a.blockedBy, cells) } : a));
      res.status(200).json({ success: true, data: { ...data, actions } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (/not found/i.test(e.message)) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      reportError(e, { source: 'AdminPatientStatusActionsController:list' });
      res.status(500).json({ success: false, error: 'Failed to load patient status actions', details: e.message });
    }
  }

  /** POST /patients/:id/status-actions */
  async perform(req: Request, res: Response): Promise<void> {
    const params = adminPatientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: params.error.flatten() });
      return;
    }
    const body = patientStatusActionSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid status action', details: body.error.flatten() });
      return;
    }

    // Mesma guarda do PUT: pela CHAVE presente (`onHoldNote: null` APAGA a nota). Só quem LÊ texto clínico restrito escreve (D211.2).
    const onHoldNoteInBody = Object.prototype.hasOwnProperty.call(req.body, 'onHoldNote');
    if (onHoldNoteInBody && !canReadPatientClinical(clinicalCellsOf(req))) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { field: 'onHoldNote', cell: PATIENT_CLINICAL_READ_CELL } });
      return;
    }

    try {
      const { action, onHoldReason, onHoldNote, suspensionExitReason } = body.data;
      const result = await this.applyUseCase.execute({
        patientId: params.data.id,
        acao: action as Acao,
        onHoldReason: (onHoldReason ?? null) as OnHoldReason | null,
        // Chave ausente → `undefined` → o escritor NÃO toca a coluna.
        onHoldNote: onHoldNoteInBody ? (onHoldNote ?? null) : undefined,
        suspensionExitReason: suspensionExitReason as SuspensionExitReason | null | undefined,
        actorUid: AuthMiddleware.getAuthContext(req)?.principal.id,
        // Spec 051: a célula do ator chega ao escritor. `null` (engine neutro) NÃO vira `[]`.
        cells: clinicalCellsOf(req),
      });
      dispatchPatientTalentumPause(result.talentum, 'AdminPatientStatusActionsController');
      res.status(200).json({ success: true, data: { id: result.id, action: result.acao, from: result.from, status: result.status } });
    } catch (err: unknown) {
      if (respondPatientStatusError(err, req, res)) return;
      const e = err instanceof Error ? err : new Error(String(err));
      if (/not found/i.test(e.message)) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      reportError(e, { source: 'AdminPatientStatusActionsController:perform' });
      res.status(500).json({ success: false, error: 'Failed to apply patient status action', details: e.message });
    }
  }
}
