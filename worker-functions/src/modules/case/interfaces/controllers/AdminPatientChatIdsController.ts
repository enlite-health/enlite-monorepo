import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { adminPatientParamsSchema } from '../validators/adminPatientParamsSchema';
import {
  patientChatIdsSchema,
  patientChatCandidatesQuerySchema,
  patientChatMapQuerySchema,
  chatGroupsQuerySchema,
} from '../validators/patientChatIdsSchema';
import { ListChatGroupsUseCase } from '../../application/ListChatGroupsUseCase';
import { GetPatientChatMapUseCase } from '../../application/GetPatientChatMapUseCase';
import { legacyChatIdAliases } from '../../domain/PatientChatId';
import {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
  ChatIdOwnedBySamePatientRoleError,
  UnknownChatRoleError,
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
 * AdminPatientChatIdsController — os chat IDs de grupo do paciente, por papel.
 *
 *   GET /api/admin/patients/:id/chat-candidates — grupos parecidos com o nome
 *       do paciente (leitura no Periskope, atrás do kill-switch).
 *   PUT /api/admin/patients/:id/chat-ids        — grava os papéis escolhidos.
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
    private readonly listGroups: ListChatGroupsUseCase = new ListChatGroupsUseCase(),
  ) {}

  /**
   * GET /api/admin/chat-groups?search=&limit=&offset= — TODOS os grupos da org.
   *
   * Não é escopado a paciente de propósito: a pergunta que ele responde é "qual
   * é o grupo da obra social?", que não tem nada a ver com o nome de um
   * paciente. Para "qual destes é o grupo DELE?" existe /chat-candidates.
   *
   * Atrás do MESMO kill-switch do lookup: é a mesma leitura no Periskope.
   */
  async getChatGroups(req: Request, res: Response): Promise<void> {
    const query = chatGroupsQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query', details: query.error.flatten() });
      return;
    }

    if (!isChatLookupEnabled()) {
      res.status(503).json({ success: false, error: 'Chat lookup disabled', code: 'FEATURE_DISABLED' });
      return;
    }

    try {
      const result = await this.listGroups.execute(query.data);
      if (!result.ok) {
        res.status(502).json({ success: false, error: result.reason, code: result.reason.toUpperCase() });
        return;
      }
      const { ok: _ok, ...data } = result;
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientChatIdsController:getChatGroups' });
      res.status(500).json({ success: false, error: 'Failed to list chat groups' });
    }
  }

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
        data: {
          candidates: result.candidates,
          candidatesByRole: result.candidatesByRole,
          totalGroups: result.totalGroups,
          groupListTruncated: result.groupListTruncated,
        },
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
      const chatIds = await this.service.update(params.data.id, body.data);
      res.status(200).json({
        success: true,
        data: { id: params.data.id, chatIds, ...legacyChatIdAliases(chatIds) },
      });
    } catch (err: unknown) {
      if (err instanceof PatientChatIdsNotFoundError) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      // Papel fora do catálogo ATIVO. 400 (não 404): o recurso pedido é o
      // paciente, que existe — o que não confere é o vocabulário do body. O
      // código próprio existe para a tela poder dizer "esse papel não está
      // cadastrado, veja a tela de papéis" em vez de um erro de validação cru.
      if (err instanceof UnknownChatRoleError) {
        res.status(400).json({
          success: false,
          error: 'Unknown or inactive chat role',
          code: 'UNKNOWN_CHAT_ROLE',
          details: { roles: err.roles },
        });
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
      // Mesmo paciente, papel diferente do que o body tocou — mensagem PRÓPRIA
      // porque "já vinculado a outro paciente" seria FALSO aqui (achado de
      // review, 11/08). A saída é incluir o papel antigo no MESMO body (`null`
      // desvincula) para mover o chat_id de propósito.
      if (err instanceof ChatIdOwnedBySamePatientRoleError) {
        res.status(409).json({
          success: false,
          error:
            'Chat id already linked to this same patient under a different role; ' +
            'include the old role explicitly (set it to null) in the same request to move it',
          code: 'CHAT_ID_OWNED_BY_SAME_PATIENT',
          details: { conflicts: err.conflicts },
        });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // 23505 = unique_violation de alguma das 3 constraints da tabela (migration
      // 261): o índice único parcial (exclusividade entre PACIENTES, migration
      // 260/261), `patient_chat_ids_one_role_per_chat` (mesmo paciente, chat_id
      // já em OUTRO papel — o caso do ChatIdOwnedBySamePatientRoleError acima,
      // só que chegando por uma corrida em vez do check prévio) ou
      // `patient_chat_ids_one_per_role` (defensivo — o UPSERT em
      // `applyChatIds` já usa ON CONFLICT (patient_id, role), então esta nunca
      // deveria disparar por aqui). `err.constraint` (achado de review, 11/08 —
      // antes este catch tratava QUALQUER 23505 como "outro paciente", inclusive
      // quando o verdadeiro conflito era com o PRÓPRIO paciente) escolhe a
      // mensagem certa; sem constraint reconhecida, cai no genérico de sempre.
      if ((err as { code?: string }).code === '23505') {
        const constraint = (err as { constraint?: string }).constraint;
        if (constraint === 'patient_chat_ids_one_role_per_chat') {
          res.status(409).json({
            success: false,
            error: 'Chat id already linked to this same patient under a different role',
            code: 'CHAT_ID_OWNED_BY_SAME_PATIENT',
          });
          return;
        }
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
