import { Request, Response } from 'express';
import { Pool } from 'pg';
import { IMessagingService } from '../../domain/IMessagingService';
import { MessageTemplateRepository } from '../../infrastructure/MessageTemplateRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BulkDispatchIncompleteWorkersUseCase } from '../../application/BulkDispatchIncompleteWorkersUseCase';
import { AuthMiddleware } from '@modules/identity';
import { logger, reportError } from '@shared/logging';

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
   * POST /api/admin/messaging/whatsapp
   * Envia mensagem WhatsApp para um worker pelo seu ID.
   *
   * Body:
   *   workerId: string
   *   templateSlug: string
   *   variables?: Record<string, string>
   *   jobPostingId?: string  — quando informado com template vacancy_match, atualiza messaged_at
   */
  async sendToWorker(req: Request, res: Response): Promise<void> {
    const { workerId, templateSlug, variables, jobPostingId } = req.body;

    if (!workerId || !templateSlug) {
      res.status(400).json({ error: 'workerId e templateSlug são obrigatórios' });
      return;
    }

    if (typeof templateSlug !== 'string' || templateSlug.trim().length === 0) {
      res.status(400).json({ error: 'templateSlug não pode ser vazio' });
      return;
    }

    const workerResult = await this.db.query<{ whatsapp_phone_encrypted: string | null; phone: string | null }>(
      `SELECT whatsapp_phone_encrypted, phone FROM workers WHERE id = $1 LIMIT 1`,
      [workerId]
    );

    if (workerResult.rows.length === 0) {
      res.status(404).json({ error: 'Worker não encontrado' });
      return;
    }

    const { whatsapp_phone_encrypted, phone } = workerResult.rows[0];
    const whatsappPhone = whatsapp_phone_encrypted
      ? await this.encryptionService.decrypt(whatsapp_phone_encrypted)
      : null;
    const to = whatsappPhone || phone;

    if (!to) {
      res.status(422).json({ error: 'Worker não possui número de telefone cadastrado' });
      return;
    }

    const result = await this.messaging.sendWhatsApp({ to, templateSlug: templateSlug.trim(), variables });

    if (result.isFailure) {
      res.status(502).json({ error: result.error });
      return;
    }

    // Rastreia envio de templates de match de vaga (ar_vacancy_match_complete /
    // ar_vacancy_match_incomplete): atualiza messaged_at na candidatura correspondente.
    if (templateSlug.trim().startsWith('ar_vacancy_match') && jobPostingId) {
      await this.db.query(
        `UPDATE worker_job_applications
         SET messaged_at = NOW(), updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerId, jobPostingId]
      ).catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn({ error: error.message, workerId, jobPostingId }, 'Falha ao atualizar messaged_at');
      });
    }

    // Persiste log de envio individual — best-effort, nunca bloqueia a resposta
    const triggeredBy = `admin:${AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown'}`;
    const { externalId, to: normalizedTo } = result.getValue()!;
    await this.db.query(
      `INSERT INTO whatsapp_bulk_dispatch_logs
         (worker_id, triggered_by, phone, template_slug, status, twilio_sid, source)
       VALUES ($1, $2, $3, $4, 'sent', $5, 'individual')`,
      [workerId, triggeredBy, normalizedTo, templateSlug.trim(), externalId],
    ).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ error: error.message, workerId, templateSlug }, 'Falha ao gravar log individual');
      reportError(error, { source: 'MessagingController.sendToWorker:log', workerId, templateSlug });
    });

    res.status(200).json({ success: true, data: result.getValue() });
  }

  /**
   * POST /api/admin/messaging/whatsapp/direct
   * Envia mensagem WhatsApp diretamente para um número (uso interno/admin).
   *
   * Body:
   *   to: string  — número em formato E.164 ou local
   *   templateSlug: string
   *   variables?: Record<string, string>
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
    await this.db.query(
      `INSERT INTO whatsapp_bulk_dispatch_logs
         (worker_id, triggered_by, phone, template_slug, status, twilio_sid, source)
       VALUES (
         (SELECT id FROM workers
          WHERE (REGEXP_REPLACE(phone, '^\+', '') = $2)
            AND merged_into_id IS NULL
          LIMIT 1),
         $1, $3, $4, 'sent', $5, 'individual'
       )`,
      [triggeredBy, digitsOnly, normalizedTo, templateSlug.trim(), externalId],
    ).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ error: error.message }, 'MessagingController sendDirect log error');
    });

    res.status(200).json({ success: true, data: result.getValue() });
  }

  /**
   * GET /api/admin/messaging/templates
   * Lista templates utilizáveis no UI de envio: ativos + com content_sid
   * (HSM aprovado no Twilio). Templates sem content_sid são ocultados porque
   * não chegam ao destinatário fora da janela de 24h do WhatsApp Business.
   *
   * Query params (admin/gestão):
   *   ?all=true             — inclui inativos
   *   ?includeUnlinked=true — inclui templates sem content_sid
   */
  async listTemplates(req: Request, res: Response): Promise<void> {
    const onlyActive = req.query.all !== 'true';
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
   * Envia WhatsApp (template complete_register_ofc) para todos os workers
   * com encuadre que possuem documentos ou perfil incompletos.
   *
   * Persiste cada envio em whatsapp_bulk_dispatch_logs com o UID do admin
   * que disparou e o status de sucesso/erro.
   */
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
