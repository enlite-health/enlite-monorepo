/**
 * Diff engine: dado o estado atual do banco + Twilio aprovados, calcula
 * o plano de INSERT/UPDATE/DELETE.
 *
 * Body NUNCA é sobrescrito automaticamente — TwilioMessagingService usa
 * placeholders nomeados ({{worker_name}}) que precisam casar com o que o
 * frontend envia. Body Twilio (numérico) seria conflito funcional.
 */
import { extractBody, TwilioContent, WhatsAppApproval } from './twilio-client';
import { DbTemplateRow } from './db';

export interface InsertPlan {
  slug: string;
  name: string;
  body: string;
  category: string | null;
  contentSid: string;
}

export interface UpdatePlan {
  id: string;
  slug: string;
  fields: Partial<Pick<DbTemplateRow, 'name' | 'category' | 'content_sid' | 'is_active'>>;
  bodyDiverges: boolean;
  bodyTwilio: string;
}

export interface DeletePlan {
  id: string;
  slug: string;
  reason: string;
}

export interface SyncPlan {
  inserts: InsertPlan[];
  updates: UpdatePlan[];
  deletes: DeletePlan[];
}

export interface ApprovedTwilioEntry {
  content: TwilioContent;
  approval: WhatsAppApproval | null;
}

export function computePlan(
  approvedTwilio: ApprovedTwilioEntry[],
  dbRows: DbTemplateRow[],
): SyncPlan {
  const dbBySid = new Map<string, DbTemplateRow>();
  const dbBySlug = new Map<string, DbTemplateRow>();
  for (const row of dbRows) {
    if (row.content_sid) dbBySid.set(row.content_sid, row);
    dbBySlug.set(row.slug, row);
  }

  const approvedSids = new Set(approvedTwilio.map(t => t.content.sid));
  const inserts: InsertPlan[] = [];
  const updates: UpdatePlan[] = [];

  for (const { content, approval } of approvedTwilio) {
    const body = extractBody(content.types);
    const category = approval?.category ?? null;

    const matched = dbBySid.get(content.sid) ?? dbBySlug.get(content.friendly_name) ?? null;
    if (matched) {
      const upd = buildUpdatePlan(matched, content, body, category);
      if (upd) updates.push(upd);
      continue;
    }

    inserts.push({
      slug: content.friendly_name,
      name: content.friendly_name,
      body,
      category,
      contentSid: content.sid,
    });
  }

  // DELETE: rows do banco cujo content_sid não está em approvedSids E
  // que não foram updateadas via match por slug.
  const updatedSlugs = new Set(updates.map(u => u.slug));
  const deletes: DeletePlan[] = [];
  for (const row of dbRows) {
    if (updatedSlugs.has(row.slug)) continue;
    if (row.content_sid && approvedSids.has(row.content_sid)) continue;
    deletes.push({
      id: row.id,
      slug: row.slug,
      reason: row.content_sid
        ? `content_sid ${row.content_sid} não está nos aprovados Twilio`
        : 'sem content_sid e sem match por friendly_name',
    });
  }

  return { inserts, updates, deletes };
}

function buildUpdatePlan(
  row: DbTemplateRow,
  content: TwilioContent,
  body: string,
  category: string | null,
): UpdatePlan | null {
  const fields: UpdatePlan['fields'] = {};
  if (row.content_sid !== content.sid) fields.content_sid = content.sid;
  if (row.name !== content.friendly_name) fields.name = content.friendly_name;
  if (category !== null && row.category !== category) fields.category = category;
  if (!row.is_active) fields.is_active = true;
  const bodyDiverges = row.body !== body;
  if (Object.keys(fields).length === 0 && !bodyDiverges) return null;
  return { id: row.id, slug: row.slug, fields, bodyDiverges, bodyTwilio: body };
}
