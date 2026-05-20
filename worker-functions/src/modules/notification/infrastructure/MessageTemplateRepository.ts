import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { MessageTemplate, UpsertMessageTemplateDTO } from '../domain/MessageTemplate';

export class MessageTemplateRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  // ─────────────────────────────────────────────────────────────────
  // findBySlug — retorna null se não encontrado ou inativo
  // ─────────────────────────────────────────────────────────────────
  async findBySlug(slug: string): Promise<MessageTemplate | null> {
    const result = await this.pool.query<Record<string, any>>(
      `SELECT * FROM message_templates WHERE slug = $1 AND is_active = true LIMIT 1`,
      [slug],
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  // ─────────────────────────────────────────────────────────────────
  // findAll — lista templates.
  //   onlyActive=true (default): exclui is_active=false
  //   requireContentSid=true (default): exclui templates sem HSM aprovado
  //     no Twilio (content_sid IS NULL) — esses não chegam ao destinatário
  //     fora da janela de 24h e não devem aparecer em dropdowns de envio.
  //   allowedSlugs (opcional): restringe a uma whitelist explícita de slugs.
  //     Usado pelo dropdown de envio manual pra exibir apenas templates
  //     curados (não os auto-disparados).
  // ─────────────────────────────────────────────────────────────────
  async findAll(
    onlyActive = true,
    requireContentSid = true,
    allowedSlugs?: string[],
  ): Promise<MessageTemplate[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (onlyActive) conditions.push('is_active = true');
    if (requireContentSid) conditions.push('content_sid IS NOT NULL');
    if (allowedSlugs && allowedSlugs.length > 0) {
      params.push(allowedSlugs);
      conditions.push(`slug = ANY($${params.length}::text[])`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.pool.query<Record<string, any>>(
      `SELECT * FROM message_templates ${where} ORDER BY category, slug`,
      params,
    );
    return result.rows.map(r => this.mapRow(r));
  }

  // ─────────────────────────────────────────────────────────────────
  // upsert — ON CONFLICT (slug):
  //   name, body, category → sempre sobrescreve (intenção explícita de atualização)
  //   is_active            → sempre sobrescreve (permite reativar/desativar)
  //   updated_at           → sempre NOW()
  // ─────────────────────────────────────────────────────────────────
  async upsert(dto: UpsertMessageTemplateDTO): Promise<{ entity: MessageTemplate; created: boolean }> {
    const result = await this.pool.query<Record<string, any>>(
      `INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET
         name        = EXCLUDED.name,
         body        = EXCLUDED.body,
         category    = EXCLUDED.category,
         is_active   = EXCLUDED.is_active,
         content_sid = EXCLUDED.content_sid,
         updated_at  = NOW()
       RETURNING *, (xmax = 0) AS inserted`,
      [
        dto.slug,
        dto.name,
        dto.body,
        dto.category ?? null,
        dto.isActive ?? true,
        dto.contentSid ?? null,
      ],
    );

    return {
      entity: this.mapRow(result.rows[0]),
      created: result.rows[0].inserted,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // deactivate — soft delete: sets is_active=false
  // Retorna true se o template existia, false se não encontrado.
  // ─────────────────────────────────────────────────────────────────
  async deactivate(slug: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE message_templates SET is_active = false, updated_at = NOW() WHERE slug = $1`,
      [slug],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private mapRow(row: Record<string, any>): MessageTemplate {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      body: row.body,
      category: row.category,
      isActive: row.is_active,
      contentSid: row.content_sid ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
