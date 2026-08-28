import { Request, Response } from 'express';
import { Pool } from 'pg';
import { IMessagingService } from '../../domain/IMessagingService';
import { MessageTemplateRepository } from '../../infrastructure/MessageTemplateRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BulkDispatchIncompleteWorkersUseCase } from '../../application/BulkDispatchIncompleteWorkersUseCase';
import { BuildVacancyMatchVariablesUseCase } from '../../application/BuildVacancyMatchVariablesUseCase';
import { assertVacancyInviteAllowed } from '../../application/VacancyInviteGuard';
import { AuthMiddleware } from '@modules/identity';
import { logger, reportError } from '@shared/logging';

const SLUG_COMPLETE   = 'ar_vacancy_match_complete';
const SLUG_INCOMPLETE = 'ar_vacancy_match_incomplete';

export class MessagingController {
  private messaging: IMessagingService;
  private templateRepo: MessageTemplateRepository;
  private db: Pool;
  private encryptionService: KMSEncryptionService;

  constructor(messaging: IMessagingService, templateRepo: MessageTemplateRepository) {
    this.messaging = messaging;
    this.templateRepo = templateRepo;
    this.db = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  /**
   * POST /api/admin/messaging/whatsapp/vacancy-match
   * Envia convite de match de vaga para um worker.
   * O template é decidido automaticamente pelo status do worker:
   *   REGISTERED          → ar_vacancy_match_complete
   *   INCOMPLETE_REGISTER → ar_vacancy_match_incomplete
   *   DISABLED (ou outro) → 422 WORKER_STATUS_INVALID
   *
   * Body: { workerId: string, jobPostingId: string, resend?: boolean }
   *   resend=true → reenvio explícito pela recrutadora (botão "Reenviar" da
   *   tarjeta, REQ-08): o guard roda em modo `resend` (ver VacancyInviteGuard).
   */
  async sendVacancyMatch(req: Request, res: Response): Promise<void> {
    const { workerId, jobPostingId, resend } = req.body as Record<string, unknown>;

    if (!workerId || !jobPostingId) {
      res.status(400).json({ error: 'workerId e jobPostingId são obrigatórios' });
      return;
    }

    const workerResult = await this.db.query<{
      status: string | null;
      whatsapp_phone_encrypted: string | null;
      phone: string | null;
      messaging_channel: string | null;
    }>(
      `SELECT status, whatsapp_phone_encrypted, phone, messaging_channel
       FROM workers
       WHERE id = $1
       LIMIT 1`,
      [workerId],
    );

    if (workerResult.rows.length === 0) {
      res.status(404).json({ error: 'Worker não encontrado' });
      return;
    }

    const { status, whatsapp_phone_encrypted, phone, messaging_channel } = workerResult.rows[0];

    let slug: string;
    if (status === 'REGISTERED') {
      slug = SLUG_COMPLETE;
    } else if (status === 'INCOMPLETE_REGISTER') {
      slug = SLUG_INCOMPLETE;
    } else {
      res
        .status(422)
        .json({
          error: 'WORKER_STATUS_INVALID',
          detail: `Worker em status ${status ?? 'desconhecido'} não pode receber convite de match`,
        });
      return;
    }

    // Travas anti-spam (espelham o VacancyAutoInviteHandler + throttle de
    // não-resposta). Rodam ANTES de resolver telefone/variáveis pra não gerar
    // token PII num envio que será bloqueado.
    const mode = resend === true ? 'resend' : 'invite';
    const guard = await assertVacancyInviteAllowed(this.db, String(workerId), String(jobPostingId), { mode });
    if (!guard.allowed) {
      logger.info({ workerId, jobPostingId, code: guard.code, mode }, 'Convite de vaga bloqueado pelo guard');
      res.status(422).json({ error: guard.code, detail: guard.detail });
      return;
    }

    const whatsappPhone = whatsapp_phone_encrypted
      ? await this.encryptionService.decrypt(whatsapp_phone_encrypted)
      : null;
    const to = whatsappPhone || phone;

    if (!to) {
      res.status(422).json({ error: 'Worker não possui número de telefone cadastrado' });
      return;
    }

    const builder = new BuildVacancyMatchVariablesUseCase(this.db, this.encryptionService);
    const variables = await builder.execute(String(workerId), String(jobPostingId), slug);

    const channel: 'twilio' | 'periskope' = messaging_channel === 'periskope' ? 'periskope' : 'twilio';
    const result = await this.messaging.sendWhatsApp({
      to,
      templateSlug: slug,
      variables: variables as unknown as Record<string, string>,
      channel,
    });

    if (result.isFailure) {
      res.status(502).json({ error: result.error });
      return;
    }

    const { externalId, to: normalizedTo } = result.getValue()!;
    const triggeredBy = `admin:${AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown'}`;

    // Atualiza messaged_at na candidatura — best-effort
    await this.db
      .query(
        `UPDATE worker_job_applications
         SET messaged_at = NOW(), updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerId, jobPostingId],
      )
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn({ error: error.message, workerId, jobPostingId }, 'Falha ao atualizar messaged_at');
      });

    // Persiste log de envio individual — best-effort
    await this.db
      .query(
        `INSERT INTO whatsapp_bulk_dispatch_logs
           (worker_id, job_posting_id, triggered_by, phone, template_slug, status, twilio_sid, source)
         VALUES ($1, $2, $3, $4, $5, 'sent', $6, 'individual')`,
        [workerId, jobPostingId, triggeredBy, normalizedTo, slug, externalId],
      )
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn({ error: error.message, workerId, templateSlug: slug }, 'Falha ao gravar log individual');
        reportError(error, { source: 'MessagingController.sendVacancyMatch:log', workerId, templateSlug: slug });
      });

    res.status(200).json({ success: true, data: { templateSlug: slug, ...result.getValue() } });
  }

  /**
   * POST /api/admin/messaging/whatsapp/direct
   * Envia mensagem WhatsApp diretamente para um número (uso interno/admin).
   *
   * Body:
   *   to: string  — número em formato E.164 ou local
   *   templateSlug: string
   *   variables?: Record<string, string>
   *
   * DECISÃO (roteamento por canal): este endpoint é @deprecated (rota de teste
   * admin, sem workerId no body — só `to` cru) e continua SEM resolver
   * channel, caindo no default do RoutingMessagingService (twilio, salvo
   * MESSAGING_PROVIDER=periskope). Resolver o worker canônico a partir de `to`
   * exigiria normalizar o telefone e fazer lookup extra só para uma rota
   * deprecated de teste pontual — não vale o custo. Se este endpoint sair de
   * deprecação, revisitar (resolver channel via lookup por phone, como
   * sendVacancyMatch faz por workerId).
   */
  async sendDirect(req: Request, res: Response): Promise<void> {
    const { to, templateSlug, variables } = req.body;

    if (!to || !templateSlug) {
      res.status(400).json({ error: 'to e templateSlug são obrigatórios' });
      return;
    }

    if (typeof templateSlug !== 'string' || templateSlug.trim().length === 0) {
      res.status(400).json({ error: 'templateSlug não pode ser vazio' });
      return;
    }

    const result = await this.messaging.sendWhatsApp({ to, templateSlug: templateSlug.trim(), variables });

    if (result.isFailure) {
      res.status(502).json({ error: result.error });
      return;
    }

    const { externalId, to: normalizedTo } = result.getValue()!;
    const triggeredBy = `admin:${AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown'}`;

    const digitsOnly = normalizedTo.replace(/^\+/, '');
    await this.db
      .query(
        `INSERT INTO whatsapp_bulk_dispatch_logs
           (worker_id, triggered_by, phone, template_slug, status, twilio_sid, source)
         VALUES (
           (SELECT id FROM workers
            WHERE (REGEXP_REPLACE(phone, '^\\+', '') = $2)
              AND merged_into_id IS NULL
            LIMIT 1),
           $1, $3, $4, 'sent', $5, 'individual'
         )`,
        [triggeredBy, digitsOnly, normalizedTo, templateSlug.trim(), externalId],
      )
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn({ error: error.message }, 'MessagingController sendDirect log error');
      });

    res.status(200).json({ success: true, data: result.getValue() });
  }

  /**
   * GET /api/admin/messaging/templates
   * Lista todos os templates de mensagem.
   *
   * Query params (admin/gestão):
   *   ?all=true             — inclui inativos
   *   ?includeUnlinked=true — inclui templates sem content_sid
   */
  async listTemplates(req: Request, res: Response): Promise<void> {
    const adminAll = req.query.all === 'true';
    const onlyActive = !adminAll;
    const requireContentSid = req.query.includeUnlinked !== 'true';
    const templates = await this.templateRepo.findAll(onlyActive, requireContentSid);
    res.status(200).json({ success: true, data: templates });
  }

  /**
   * POST /api/admin/messaging/templates
   * Cria ou atualiza template (upsert por slug).
   * Retorna 201 se criado, 200 se atualizado.
   *
   * Body: slug, name, body, category?
   */
  async createTemplate(req: Request, res: Response): Promise<void> {
    const { slug, name, body, category } = req.body;

    if (!slug || !name || !body) {
      res.status(400).json({ error: 'slug, name e body são obrigatórios' });
      return;
    }

    const { entity, created } = await this.templateRepo.upsert({ slug, name, body, category });
    res.status(created ? 201 : 200).json({ success: true, data: entity });
  }

  /**
   * PUT /api/admin/messaging/templates/:slug
   * Atualiza name, body e category de um template existente.
   * Preserva is_active atual (não reativa nem desativa).
   *
   * Body: name, body, category?, isActive?
   */
  async updateTemplate(req: Request, res: Response): Promise<void> {
    const { slug } = req.params;
    const { name, body, category, isActive } = req.body;

    if (!name || !body) {
      res.status(400).json({ error: 'name e body são obrigatórios' });
      return;
    }

    const { entity } = await this.templateRepo.upsert({ slug, name, body, category, isActive });
    res.status(200).json({ success: true, data: entity });
  }

  /**
   * DELETE /api/admin/messaging/templates/:slug
   * Desativa (soft delete) um template.
   */
  async deleteTemplate(req: Request, res: Response): Promise<void> {
    const { slug } = req.params;
    const found = await this.templateRepo.deactivate(slug);

    if (!found) {
      res.status(404).json({ error: 'Template não encontrado' });
      return;
    }

    res.status(200).json({ success: true });
  }

  /**
   * POST /api/admin/messaging/bulk-dispatch-incomplete
   *
   * Query params opcionais:
   *   ?dryRun=true  — retorna quem receberia sem chamar o Twilio (validação prévia)
   *   ?limit=N      — dispara apenas para os primeiros N workers (teste pontual)
   */
  async bulkDispatchIncomplete(req: Request, res: Response): Promise<void> {
    const authContext = AuthMiddleware.getAuthContext(req);
    const triggeredBy = authContext?.principal.id ?? 'unknown';

    const dryRun = req.query.dryRun === 'true';
    const limitRaw = parseInt(req.query.limit as string ?? '', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    const useCase = new BulkDispatchIncompleteWorkersUseCase(this.db, this.messaging);
    const result = await useCase.execute(triggeredBy, { dryRun, limit });

    if (result.isFailure) {
      res.status(500).json({ error: result.error });
      return;
    }

    const data = result.getValue()!;
    res.status(200).json({ success: true, data });
  }
}
