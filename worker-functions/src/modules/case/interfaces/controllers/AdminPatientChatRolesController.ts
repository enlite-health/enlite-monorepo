import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import {
  createPatientChatRoleSchema,
  updatePatientChatRoleSchema,
  patientChatRoleParamsSchema,
  listPatientChatRolesQuerySchema,
} from '../validators/patientChatRolesSchema';
import {
  PatientChatRolesService,
  ChatRoleNotFoundError,
  ChatRoleAlreadyExistsError,
  ChatRoleInUseError,
  ChatRoleExclusivityConflictError,
} from '../../application/PatientChatRolesService';

/**
 * AdminPatientChatRolesController — o CRUD do CATÁLOGO de papéis de chat.
 *
 *   GET    /api/admin/patient-chat-roles           — staff (a ficha do paciente
 *                                                    precisa dos rótulos)
 *   POST   /api/admin/patient-chat-roles           — admin
 *   PATCH  /api/admin/patient-chat-roles/:code     — admin
 *   DELETE /api/admin/patient-chat-roles/:code     — admin
 *
 * ⚠️ As DUAS recusas desta tela têm código próprio e carregam NÚMERO. "Não dá"
 * sem contagem obriga quem opera a adivinhar se são 2 pacientes ou 200 antes de
 * ir mexer, e a saída dela seria pedir para alguém abrir o banco.
 *
 * Sem PII: papel é vocabulário da operação, não dado de pessoa — o `chat_id` que
 * aparece no conflito de exclusividade é identificador de grupo, não nome.
 */
export class AdminPatientChatRolesController {
  constructor(private readonly service: PatientChatRolesService = new PatientChatRolesService()) {}

  /** GET /api/admin/patient-chat-roles?includeInactive=true */
  async list(req: Request, res: Response): Promise<void> {
    const query = listPatientChatRolesQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query', details: query.error.flatten() });
      return;
    }

    try {
      // `includeInactive` é a visão da ADMINISTRAÇÃO; a ficha do paciente pede a
      // lista limpa. A contagem de uso só acompanha a visão de administração —
      // é uma query por papel, e a ficha do paciente não tem o que fazer com ela.
      const roles = query.data.includeInactive
        ? await this.service.listAll()
        : await this.service.listActive();
      const usage = query.data.includeInactive ? await this.service.usageByRole() : undefined;

      res.status(200).json({ success: true, data: { roles, ...(usage ? { usage } : {}) } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientChatRolesController:list' });
      res.status(500).json({ success: false, error: 'Failed to list patient chat roles' });
    }
  }

  /** POST /api/admin/patient-chat-roles */
  async create(req: Request, res: Response): Promise<void> {
    const body = createPatientChatRoleSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: body.error.flatten() });
      return;
    }

    try {
      const role = await this.service.create(body.data);
      res.status(201).json({ success: true, data: role });
    } catch (err: unknown) {
      if (err instanceof ChatRoleAlreadyExistsError) {
        res.status(409).json({
          success: false,
          error: 'Chat role already exists',
          code: 'CHAT_ROLE_ALREADY_EXISTS',
          details: { code: err.code },
        });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // 23505 na PK: outra transação criou o mesmo código entre o findByCode e
      // o INSERT. Mesma resposta do caminho checado — a corrida não muda o que
      // quem opera precisa fazer.
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({
          success: false,
          error: 'Chat role already exists',
          code: 'CHAT_ROLE_ALREADY_EXISTS',
        });
        return;
      }
      reportError(e, { source: 'AdminPatientChatRolesController:create' });
      res.status(500).json({ success: false, error: 'Failed to create patient chat role' });
    }
  }

  /** PATCH /api/admin/patient-chat-roles/:code */
  async update(req: Request, res: Response): Promise<void> {
    const params = patientChatRoleParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: params.error.flatten() });
      return;
    }

    const body = updatePatientChatRoleSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: body.error.flatten() });
      return;
    }

    try {
      const role = await this.service.update(params.data.code, body.data);
      res.status(200).json({ success: true, data: role });
    } catch (err: unknown) {
      if (this.replyRefusal(err, res)) return;
      const e = err instanceof Error ? err : new Error(String(err));
      // 23505 no índice único parcial (`idx_patient_chat_ids_exclusive_chat`):
      // outra transação linkou um grupo conflitante ENTRE a checagem da TRAVA 1
      // (`findSharedGroups`) e este UPDATE — mesma corrida que `create()` cobre
      // na PK, só que aqui bate na exclusividade. Sem isto, virava 500 genérico
      // numa race real (achado de review, 11/08).
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({
          success: false,
          error: 'Cannot make role exclusive: a conflicting group appeared between the check and the write',
          code: 'CHAT_ROLE_EXCLUSIVITY_CONFLICT',
        });
        return;
      }
      reportError(e, { source: 'AdminPatientChatRolesController:update' });
      res.status(500).json({ success: false, error: 'Failed to update patient chat role' });
    }
  }

  /** DELETE /api/admin/patient-chat-roles/:code */
  async delete(req: Request, res: Response): Promise<void> {
    const params = patientChatRoleParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: params.error.flatten() });
      return;
    }

    try {
      await this.service.delete(params.data.code);
      res.status(204).end();
    } catch (err: unknown) {
      if (this.replyRefusal(err, res)) return;
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientChatRolesController:delete' });
      res.status(500).json({ success: false, error: 'Failed to delete patient chat role' });
    }
  }

  /**
   * As recusas que não podem ser silenciosas, traduzidas uma vez só.
   *
   * `409` e não `400`: o body está correto: é o ESTADO ATUAL DOS DADOS que
   * impede a operação. A diferença importa para quem consome a API — 400 pede
   * "corrija o que você mandou", 409 pede "resolva o dado e tente de novo".
   *
   * Devolve `true` quando respondeu, para quem chama saber que acabou ali.
   */
  private replyRefusal(err: unknown, res: Response): boolean {
    if (err instanceof ChatRoleNotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Chat role not found',
        code: 'CHAT_ROLE_NOT_FOUND',
        details: { code: err.code },
      });
      return true;
    }

    if (err instanceof ChatRoleInUseError) {
      res.status(409).json({
        success: false,
        error: `Chat role is in use by ${err.patientCount} patient(s)`,
        code: 'CHAT_ROLE_IN_USE',
        details: { code: err.code, patientCount: err.patientCount, operation: err.operation },
      });
      return true;
    }

    if (err instanceof ChatRoleExclusivityConflictError) {
      res.status(409).json({
        success: false,
        error: 'Cannot make role exclusive: groups are shared by more than one patient',
        code: 'CHAT_ROLE_EXCLUSIVITY_CONFLICT',
        details: {
          code: err.code,
          // chat_id é identificador de grupo, não PII: quem vai resolver o
          // conflito precisa saber QUAL grupo abrir no Periskope.
          conflicts: err.conflicts,
          groupCount: err.conflicts.length,
          patientCount: err.conflicts.reduce((sum, c) => sum + c.patientCount, 0),
        },
      });
      return true;
    }

    return false;
  }
}
