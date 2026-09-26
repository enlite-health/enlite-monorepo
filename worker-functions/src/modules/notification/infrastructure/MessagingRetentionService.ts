import { Pool } from 'pg';

export interface RetentionResult {
  outboxDeleted: number;
  bulkDeleted: number;
  tokensDeleted: number;
}

/**
 * Liga, via chamada de aplicação, as duas funções de retenção que existem no banco desde a
 * migration 087 (`archive_old_messages`, `cleanup_expired_tokens`) e nunca foram chamadas por
 * ninguém — o comentário da migration dizia "job de retenção semanal (n8n)", mas nenhum n8n bate
 * aqui, e `pg_cron` não está instalado em prd (medido 25/09/2026: `SELECT extname FROM
 * pg_extension WHERE extname='pg_cron'` → 0 linhas). Efeito medido: `messaging_variable_tokens`
 * (TTL 24h) tinha 1.501/1.501 linhas expiradas; `messaging_outbox` tinha 226 linhas sent/failed
 * com mais de 90 dias.
 *
 * `cleanup_expired_tokens()` roda ANTES de `archive_old_messages()`: tokens de PII expiram em
 * 24h (janela muito mais curta que os 90/365 dias das outras tabelas) — não há motivo para
 * esperar o ciclo de archiving para limpar o que já devia ter sumido há meses.
 *
 * Ver openspec/changes/mensageria-pii-e-retencao/design.md — Decisão B (padrão de job reusado).
 */
export class MessagingRetentionService {
  constructor(private readonly pool: Pool) {}

  async run(): Promise<RetentionResult> {
    const tokensRes = await this.pool.query<{ cleanup_expired_tokens: string }>(
      `SELECT cleanup_expired_tokens()`,
    );
    const tokensDeleted = Number(tokensRes.rows[0]?.cleanup_expired_tokens ?? 0);

    const archiveRes = await this.pool.query<{ outbox_deleted: string; bulk_deleted: string }>(
      `SELECT * FROM archive_old_messages()`,
    );
    const outboxDeleted = Number(archiveRes.rows[0]?.outbox_deleted ?? 0);
    const bulkDeleted = Number(archiveRes.rows[0]?.bulk_deleted ?? 0);

    return { outboxDeleted, bulkDeleted, tokensDeleted };
  }
}
