import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PostMessageUseCase, AttachedFileNotFoundError } from '../../application/PostMessageUseCase';
import { ListConversationUseCase } from '../../application/ListConversationUseCase';
import {
  EditMessageUseCase,
  MessageNotFoundError,
  NotMessageAuthorError,
  MessageAlreadyDeletedError,
} from '../../application/EditMessageUseCase';
import { DeleteMessageUseCase } from '../../application/DeleteMessageUseCase';
import { MarkConversationReadUseCase } from '../../application/MarkConversationReadUseCase';
import { ListRepliesUseCase, RootMessageIsReplyError } from '../../application/ListRepliesUseCase';
import { MentionedUserNotFoundError } from '../../domain/ConversationMention';
import { messageBelongsToConversation } from '../../domain/MessageThreadOwnership';
import { ConversationRepository } from '../../infrastructure/ConversationRepository';
import type { ConversationMessageCursor, TopMessageRow, ReplyMessageRow } from '../../infrastructure/ConversationRepository';
import {
  createConversationMessageSchema,
  updateConversationMessageSchema,
  conversationMessagesQuerySchema,
} from '../validators/conversationSchemas';
import { resolveConversationForPatient } from './resolveConversationForPatient';

/**
 * AdminConversationController — spec 022, Bloco 1 (T120). Um método por rota (T119), fino:
 * traduz HTTP↔domínio e delega às 5 use cases já prontas (T110/T112/T114/T115/T117). Molde:
 * `AdminPatientPhotoController.ts` (mesmo `actorUid` via `AuthMiddleware.getAuthContext`, mesmo
 * `db: Pool` só para a checagem de existência — nunca para KMS ou regra de negócio, isso vive nas
 * use cases/repositório).
 *
 * `:id` na URL é sempre o PATIENT id (o "canal" do contrato) — `resolveConversationForPatient`
 * traduz para o `conversationId` que as use cases pedem. `:mid` (editar/apagar/listar replies)
 * CRUZA com esse `conversationId` via `assertMessageBelongsToPatientConversation` (achado do gate
 * revisao-pr, Bloco 1; `listReplies` fechou a mesma classe no fecho seguinte) — mensagem de OUTRO
 * paciente nunca é alvo válido, mesmo que o requester seja o autor ou tenha a célula de leitura.
 *
 * Params validados por schema local (não em `conversationSchemas.ts`, que só cobre body/query —
 * T121, já pronto) — mesmo padrão de `patientPhotoSchemas.ts`.
 */
const patientIdParamsSchema = z.object({ id: z.string().uuid() });
const messageIdParamsSchema = z.object({ id: z.string().uuid(), mid: z.string().uuid() });

/**
 * Ator ausente (`AuthMiddleware` não resolveu identidade) — recusa (o controller converte em 401).
 * Achado do gate revisao-pr (Bloco 1): antes disto, `actorUid` lançava `Error` genérico, que
 * `handleUnexpected` sempre converte em 500 — sessão sem identidade é 401 (não autenticado), nunca
 * erro interno.
 */
class MissingActorError extends Error {
  readonly code = 'MISSING_ACTOR';
  readonly status = 401;

  constructor() {
    super('escrita exige ator identificado (lex C6)');
    this.name = 'MissingActorError';
  }
}

function parseCursor(raw: string): ConversationMessageCursor {
  const [createdAt, id] = raw.split(',');
  return { createdAt: new Date(createdAt), id };
}

/**
 * `mentions` vem de `ConversationRepository.listTopMessages` (agregação por `IN`/`GROUP BY`,
 * fecho do B1 — nunca uma query por mensagem). `attachments` continua SEMPRE vazio: anexo é
 * Bloco 3, nenhuma leitura de `conversation_message_attachments` existe ainda — retorno parcial e
 * HONESTO (array vazio real, não dado inventado), registrado em `evidencias/achados.md`.
 */
function toMessageDto(row: TopMessageRow) {
  return {
    id: row.id,
    authorUid: row.authorUid,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    mentions: row.mentions,
    replyCount: row.replyCount,
    lastReplyAt: row.lastReplyAt ? row.lastReplyAt.toISOString() : null,
    attachments: [] as Array<{ fileId: string; contentType: string; sizeBytes: number }>,
  };
}

/**
 * DTO de uma REPLY — "mesma forma de `messages[]`" do contrato (thread de 1 nível, D-03): uma
 * reply nunca tem replies próprias, então `replyCount`/`lastReplyAt` são constantes (0/null),
 * nunca uma leitura própria. `mentions` vem da MESMA agregação de `ConversationRepository.listReplies`.
 */
function toReplyDto(row: ReplyMessageRow) {
  return {
    id: row.id,
    authorUid: row.authorUid,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    mentions: row.mentions,
    replyCount: 0,
    lastReplyAt: null as string | null,
    attachments: [] as Array<{ fileId: string; contentType: string; sizeBytes: number }>,
  };
}

export class AdminConversationController {
  constructor(
    private readonly postMessageUseCase: PostMessageUseCase = new PostMessageUseCase(),
    private readonly listConversationUseCase: ListConversationUseCase = new ListConversationUseCase(),
    private readonly editMessageUseCase: EditMessageUseCase = new EditMessageUseCase(),
    private readonly deleteMessageUseCase: DeleteMessageUseCase = new DeleteMessageUseCase(),
    private readonly markReadUseCase: MarkConversationReadUseCase = new MarkConversationReadUseCase(),
    private readonly listRepliesUseCase: ListRepliesUseCase = new ListRepliesUseCase(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly repository: ConversationRepository = new ConversationRepository(),
  ) {}

  private actorUid(req: Request): string {
    const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!uid) throw new MissingActorError();
    return uid;
  }

  /**
   * `:mid` pertence à conversa de `:id` (o paciente da rota)? Achado do gate revisao-pr (Bloco 1):
   * `editMessage`/`deleteMessage` resolviam `:mid` sozinho, sem cruzar com `:id` — mensagem de
   * OUTRO paciente era alvo válido desde que o requester fosse o autor. 404 (nunca 403): não
   * confirma para o cliente que a mensagem existe sob outro paciente (evita enumeração de id).
   */
  private async assertMessageBelongsToPatientConversation(
    conversationId: string,
    messageId: string,
  ): Promise<boolean> {
    const info = await this.repository.findMessageThreadInfo(messageId, this.db);
    return messageBelongsToConversation(info, conversationId);
  }

  /**
   * GET /api/admin/patients/:id/conversation — célula `patient_conversation:read` na rota.
   * `lastReadAt`/`unreadCount` (Bloco 2, D-11) vêm de `ListConversationUseCase.execute` — o campo
   * que faltava para o badge do handle não zerar a cada F5 (achado da spec 022, `estado.md`): o
   * backend gravava a marca de leitura desde o Bloco 1, mas nunca a devolvia.
   */
  async list(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const query = conversationMessagesQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ success: false, error: 'Invalid query' }); return; }
    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }

      const result = await this.listConversationUseCase.execute({
        conversationId: lookup.conversationId,
        actorUid: this.actorUid(req),
        after: query.data.after ? parseCursor(query.data.after) : null,
        limit: query.data.limit,
      });

      res.status(200).json({
        success: true,
        data: {
          conversationId: lookup.conversationId,
          messages: result.messages.map(toMessageDto),
          nextCursor: result.nextCursor ? `${result.nextCursor.createdAt.toISOString()},${result.nextCursor.id}` : null,
          lastReadAt: result.lastReadAt ? result.lastReadAt.toISOString() : null,
          unreadCount: result.unreadCount,
        },
      });
    } catch (err: unknown) {
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'list', params.data.id);
    }
  }

  /**
   * GET /api/admin/patients/:id/conversation/messages/:mid/replies — célula `patient_conversation:read`.
   * `:mid` precisa ser mensagem de TOPO (contrato); `ListRepliesUseCase` recusa com
   * `RootMessageIsReplyError` (400) quando `:mid` já é uma reply — thread de 1 nível (D-03).
   * `:mid` também CRUZA com o `conversationId` de `:id` (`assertMessageBelongsToPatientConversation`,
   * fecho da classe do gate revisao-pr) — mensagem de OUTRO paciente devolve 404, nunca a thread.
   */
  async listReplies(req: Request, res: Response): Promise<void> {
    const params = messageIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }
      if (!(await this.assertMessageBelongsToPatientConversation(lookup.conversationId, params.data.mid))) {
        res.status(404).json({ success: false, error: 'Message not found' });
        return;
      }

      const replies = await this.listRepliesUseCase.execute({ rootMessageId: params.data.mid });
      res.status(200).json({ success: true, data: { messages: replies.map(toReplyDto) } });
    } catch (err: unknown) {
      if (err instanceof RootMessageIsReplyError) {
        res.status(400).json({ success: false, error: err.message, code: err.code });
        return;
      }
      this.handleUnexpected(err, res, 'listReplies', params.data.id);
    }
  }

  /** POST /api/admin/patients/:id/conversation/messages — célula `patient_conversation:create`. */
  async postMessage(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = createConversationMessageSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }
    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }

      const result = await this.postMessageUseCase.execute(this.db, {
        conversationId: lookup.conversationId,
        authorUid: this.actorUid(req),
        body: body.data.body,
        rootMessageId: body.data.rootMessageId ?? null,
        fileIds: body.data.fileIds,
      });
      res.status(201).json({ success: true, data: { id: result.id, createdAt: result.createdAt.toISOString() } });
    } catch (err: unknown) {
      if (err instanceof MentionedUserNotFoundError) {
        res.status(400).json({ success: false, error: err.message, code: err.code });
        return;
      }
      if (err instanceof AttachedFileNotFoundError) {
        res.status(400).json({ success: false, error: err.message, code: err.code });
        return;
      }
      // `rootMessageId` (BODY) inexistente OU de OUTRO paciente — achado do gate revisao-pr
      // (vetor de body): `PostMessageUseCase.resolveRoot` lança o MESMO `MessageNotFoundError`
      // que edit/delete usam para messageId inexistente. 404 nas duas causas, nunca distingue
      // (evita enumeração de id de mensagem de outro paciente).
      if (err instanceof MessageNotFoundError) {
        res.status(404).json({ success: false, error: err.message, code: err.code });
        return;
      }
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'postMessage', params.data.id);
    }
  }

  /** PATCH /api/admin/patients/:id/conversation/messages/:mid — célula `patient_conversation:update`; só o autor (D-04). */
  async editMessage(req: Request, res: Response): Promise<void> {
    const params = messageIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    const body = updateConversationMessageSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }
    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }
      if (!(await this.assertMessageBelongsToPatientConversation(lookup.conversationId, params.data.mid))) {
        res.status(404).json({ success: false, error: 'Message not found' });
        return;
      }

      await this.editMessageUseCase.execute(this.db, {
        messageId: params.data.mid,
        requesterUid: this.actorUid(req),
        body: body.data.body,
      });
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (err instanceof MessageNotFoundError) { res.status(404).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof NotMessageAuthorError) { res.status(403).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof MessageAlreadyDeletedError) { res.status(409).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'editMessage', params.data.id);
    }
  }

  /** DELETE /api/admin/patients/:id/conversation/messages/:mid — célula `patient_conversation:delete`; só o autor (D-04), soft delete. */
  async deleteMessage(req: Request, res: Response): Promise<void> {
    const params = messageIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }
      if (!(await this.assertMessageBelongsToPatientConversation(lookup.conversationId, params.data.mid))) {
        res.status(404).json({ success: false, error: 'Message not found' });
        return;
      }

      await this.deleteMessageUseCase.execute(this.db, {
        messageId: params.data.mid,
        requesterUid: this.actorUid(req),
      });
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (err instanceof MessageNotFoundError) { res.status(404).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof NotMessageAuthorError) { res.status(403).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'deleteMessage', params.data.id);
    }
  }

  /** PUT /api/admin/patients/:id/conversation/read-mark — célula `patient_conversation:read`. */
  async markRead(req: Request, res: Response): Promise<void> {
    const params = patientIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      const lookup = await resolveConversationForPatient(this.db, params.data.id);
      if (!lookup.patientExists || !lookup.conversationId) { res.status(404).json({ success: false, error: 'Patient not found' }); return; }

      await this.markReadUseCase.execute(this.db, {
        conversationId: lookup.conversationId,
        userUid: this.actorUid(req),
      });
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'markRead', params.data.id);
    }
  }

  private handleUnexpected(err: unknown, res: Response, source: string, patientId: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminConversationController:${source}`, patientId });
    res.status(500).json({ success: false, error: 'Internal error' });
  }
}
