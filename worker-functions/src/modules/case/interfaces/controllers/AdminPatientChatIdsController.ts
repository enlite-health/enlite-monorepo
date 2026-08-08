import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { adminPatientParamsSchema } from '../validators/adminPatientParamsSchema';
import {
  patientChatIdsSchema,
  patientChatCandidatesQuerySchema,
  patientChatMapQuerySchema,
} from '../validators/patientChatIdsSchema';
import { GetPatientChatMapUseCase } from '../../application/GetPatientChatMapUseCase';
import {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
} from '../../application/PatientChatIdsService';
import {
  FindPatientChatCandidatesUseCase,
  DEFAULT_CANDIDATE_LIMIT,
} from '../../application/FindPatientChatCandidatesUseCase';

/**
 * Kill-switch da busca de chats no Periskope. OFF por padrão: é caminho novo que
 * fala com serviço EXTERNO, e a regra do repo é que isso nasce desligado.
 *
 * Gate só sobre a LEITURA no Periskope. A gravação (PUT /chat-ids) é interna,
 * não tem flag — sem ela, virar a flag do lookup não teria onde salvar o
 * resultado, e o campo (task do modelo de dado) ficaria refém da integração.
 */
function isChatLookupEnabled(): boolean {
  return process.env.PATIENT_CHAT_LOOKUP_ENABLED === 'true';
}

/**
 * AdminPatientChatIdsController — os dois chat IDs de grupo do paciente.
 *
 *   GET /api/admin/patients/:id/chat-candidates — grupos parecidos com o nome
 *       do paciente (leitura no Periskope, atrás do kill-switch).
 *   PUT /api/admin/patients/:id/chat-ids        — grava o par escolhido.
 *
 * Controller separado do AdminPatientsController de propósito: aquele já passa
 * de 600 linhas, e o 409 de vínculo duplicado é semântica que vive só aqui.
 * Sem lógica de negócio — delega para o use case / service.
 *
 * ⚠️ Nunca loga nome de paciente nem de grupo (PII, Ley 25.326).
 */
export class AdminPatientChatIdsController {
  constructor(
    private readonly service: PatientChatIdsService = new PatientChatIdsService(),
    private readonly findCandidates: FindPatientChatCandidatesUseCase =
      new FindPatientChatCandidatesUseCase(),
    private readonly chatMap: GetPatientChatMapUseCase = new GetPatientChatMapUseCase(),
  ) {}

  /**
   * GET /api/admin/patients/chat-map — o mapa de três pontas, em massa.
   *
   * `?chatId=` liga a direção REVERSA (de qual paciente é este grupo), que é a
   * que a auditoria de informes consome. `?filter=unlinked` devolve a fila de
   * trabalho do backfill.
   *
   * Sem kill-switch: é leitura do NOSSO banco, não fala com serviço externo.
   * O payload só carrega identificadores — nunca nome, telefone ou documento.
   */
  async getChatMap(req: Request, res: Response): Promise<void> {
    const query = patientChatMapQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query', details: query.error.flatten() });
      return;
    }

    try {
      const result = await this.chatMap.execute(query.data);
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientChatIdsController:getChatMap' });
      res.status(500).json({ success: false, error: 'Failed to read patient chat map' });
    }
  }

  /** GET /api/admin/patients/:id/chat-candidates?limit=10 */
  async getChatCandidates(req: Request, res: Response): Promise<void> {
    const params = adminPatientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: params.error.flatten() });
      return;
    }

    const query = patientChatCandidatesQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query', details: query.error.flatten() });
      return;
    }

    if (!isChatLookupEnabled()) {
      res.status(503).json({
        success: false,
        error: 'Chat lookup disabled',
        code: 'FEATURE_DISABLED',
      });
      return;
    }

    try {
      const result = await this.findCandidates.execute(
        params.data.id,
        query.data.limit ?? DEFAULT_CANDIDATE_LIMIT,
      );

      if (!result.ok) {
        const status = result.reason === 'periskope_unavailable' ? 502 : 422;
        res.status(status).json({ success: false, error: result.reason, code: result.reason.toUpperCase() });
        return;
      }

      res.status(200).json({
        success: true,
        data: { candidates: result.candidates, totalGroups: result.totalGroups },
      });
    } catch (err: unknown) {
      if (err instanceof PatientChatIdsNotFoundError) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientChatIdsController:getChatCandidates' });
      res.status(500).json({ success: false, error: 'Failed to search chat candidates' });
    }
  }

  /** PUT /api/admin/patients/:id/chat-ids */
  async updateChatIds(req: Request, res: Response): Promise<void> {
    const params = adminPatientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: params.error.flatten() });
      return;
    }

    const body = patientChatIdsSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: body.error.flatten() });
      return;
    }

    try {
      const saved = await this.service.update(params.data.id, body.data);
      res.status(200).json({ success: true, data: { id: params.data.id, ...saved } });
    } catch (err: unknown) {
      if (err instanceof PatientChatIdsNotFoundError) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      if (err instanceof ChatIdAlreadyLinkedError) {
        res.status(409).json({
          success: false,
          error: 'Chat id already linked to another patient',
          code: 'CHAT_ID_ALREADY_LINKED',
          details: { conflicts: err.conflicts },
        });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // 23505 = unique_violation do índice parcial (mesmo papel, migration 260).
      // Chega aqui quando outra transação gravou entre a checagem e o UPDATE.
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({
          success: false,
          error: 'Chat id already linked to another patient',
          code: 'CHAT_ID_ALREADY_LINKED',
        });
        return;
      }
      reportError(e, { source: 'AdminPatientChatIdsController:updateChatIds' });
      res.status(500).json({ success: false, error: 'Failed to update patient chat ids' });
    }
  }
}
