// =====================
// TalentumWebhookController — endpoint POST /api/webhooks/talentum/prescreening
//
// Autenticação: Google ID Token via Service Account (emissor em identificação — TD-062).
// Sem Firebase. Token validado com OAuth2Client.verifyIdToken da google-auth-library.
// Em ambiente de teste (USE_MOCK_AUTH=true) a validação do token é ignorada.
// =====================

import { Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumPrescreeningRepository } from '../../infrastructure/TalentumPrescreeningRepository';
import { WorkerRepository } from '@modules/worker';
import { TalentumPrescreeningPayloadSchema } from '@modules/integration';
import {
  ProcessTalentumPrescreening,
  IJobPostingLookup,
} from '../../application/ProcessTalentumPrescreening';
import { PubSubClient } from '@shared/events/PubSubClient';
import { CreateJobPostingFromTalentumUseCase } from '@modules/integration';

// ─────────────────────────────────────────────────────────────────
// JobPostingLookup — implementação concreta da porta IJobPostingLookup
// Busca job_posting por ILIKE em title (prescreening.name do Talentum)
// ─────────────────────────────────────────────────────────────────
class JobPostingLookup implements IJobPostingLookup {
  constructor(private readonly pool: Pool) {}

  async findByTitleILike(name: string): Promise<{ id: string } | null> {
    const result = await this.pool.query(
      `SELECT id FROM job_postings WHERE title ILIKE $1 AND deleted_at IS NULL LIMIT 1`,
      [`%${name}%`],
    );
    return result.rows[0] ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────
// TalentumWebhookController
// ─────────────────────────────────────────────────────────────────
export class TalentumWebhookController {
  private readonly oauth2Client: OAuth2Client;
  private readonly audience: string;

  constructor() {
    this.oauth2Client = new OAuth2Client();
    // TALENTUM_WEBHOOK_AUDIENCE = URL pública da Cloud Function (configurado via env var)
    this.audience = process.env.TALENTUM_WEBHOOK_AUDIENCE ?? '';
  }

  // POST /api/webhooks/talentum/prescreening
  async handlePrescreening(req: Request, res: Response): Promise<void> {
    // ── 1. Validar Google ID Token ───────────────────────────────────
    const authError = await this.verifyGoogleToken(req);
    if (authError) {
      res.status(401).json({ error: authError });
      return;
    }

    // ── 2. Validar payload com Zod ───────────────────────────────────
    const parsed = TalentumPrescreeningPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten(),
      });
      return;
    }

    // ── 2.5. PRESCREENING.CREATED → criar job_posting (anti-loop) ───
    if (parsed.data.action === 'PRESCREENING') {
      try {
        const pool = DatabaseConnection.getInstance().getPool();
        const createUseCase = new CreateJobPostingFromTalentumUseCase(pool);
        const result = await createUseCase.execute(parsed.data.data, 'production');
        res.status(200).json({ received: true, event: 'PRESCREENING.CREATED', ...result });
      } catch (err) {
        console.error('[TalentumWebhook] PRESCREENING.CREATED error:', (err as Error)?.message ?? err);
        res.status(500).json({ error: 'Internal server error' });
      }
      return;
    }

    // ── 3. Instanciar dependências e executar use case ───────────────
    try {
      const pool = DatabaseConnection.getInstance().getPool();
      const prescreeningRepo = new TalentumPrescreeningRepository();
      const workerLookup     = new WorkerRepository();
      const jobPostingLookup = new JobPostingLookup(pool);

      const useCase = new ProcessTalentumPrescreening(
        prescreeningRepo,
        workerLookup,
        jobPostingLookup,
        pool,
        new PubSubClient(),
      );

      const result = await useCase.execute(parsed.data);

      res.status(200).json(result);
    } catch (err) {
      // Log apenas ID interno — nunca expor PII ou stack trace na resposta
      console.error('[TalentumWebhook] DB error | prescreeningId (ext):', req.body?.data?.prescreening?.id ?? 'unknown');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // verifyGoogleToken
  //   Retorna null se válido, string de erro se inválido/ausente.
  //   Bypass automático quando USE_MOCK_AUTH=true (ambiente de testes).
  // ─────────────────────────────────────────────────────────────────
  private async verifyGoogleToken(req: Request): Promise<string | null> {
    // Bypass para testes E2E (USE_MOCK_AUTH=true)
    if (process.env.USE_MOCK_AUTH === 'true') return null;

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return 'Missing or malformed Authorization header';
    }

    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken) return 'Missing ID token';

    if (!this.audience) {
      console.warn('[TalentumWebhook] TALENTUM_WEBHOOK_AUDIENCE not configured — skipping audience check');
    }

    try {
      const ticket = await this.oauth2Client.verifyIdToken({
        idToken,
        audience: this.audience || undefined,
      });

      const payload = ticket.getPayload();
      if (!payload) return 'Invalid token payload';

      // TD-062: identidade do emissor ainda desconhecida — logar até definir allowlist
      console.info('[TalentumWebhook] token OK | issuer:', payload.email ?? payload.sub ?? 'unknown');

      return null; // token válido
    } catch (err) {
      return 'Invalid or expired token';
    }
  }
}
