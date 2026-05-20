/**
 * sync-message-templates-twilio.ts
 *
 * Sincroniza message_templates com Twilio Content API.
 *
 * Fluxo:
 *  1. Fetch GET /v1/Content (paginado) — todos os Content Templates da conta
 *  2. Pra cada Content, fetch /v1/Content/{sid}/ApprovalRequests pra status WhatsApp
 *  3. Filtra só whatsapp.status='approved' (ou todos se --include-unapproved)
 *  4. Plano de mudança vs message_templates:
 *     - Twilio approved match content_sid/slug no banco → UPDATE name/category/content_sid
 *     - Twilio approved sem match no banco             → INSERT (body cru com {{1}}, {{2}})
 *     - Banco com template não-approved na Twilio      → DELETE (com whitelist de proteção)
 *  5. Body NUNCA é sobrescrito automaticamente — placeholders nomeados do banco
 *     precisam casar com variáveis enviadas pelo frontend.
 *  6. Dry-run mostra o plano. --apply executa.
 *
 * Uso:
 *   ts-node -r dotenv/config scripts/sync-message-templates-twilio.ts --dry-run
 *   ts-node -r dotenv/config scripts/sync-message-templates-twilio.ts --apply
 *   ts-node -r dotenv/config scripts/sync-message-templates-twilio.ts --apply --allow-hardcoded-delete
 *   ts-node -r dotenv/config scripts/sync-message-templates-twilio.ts --dry-run --include-unapproved
 *
 * Env obrigatórios: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 */
import { Pool } from 'pg';
import { HARDCODED_SLUGS } from './sync-message-templates/constants';
import { TwilioContentClient, TwilioContent, WhatsAppApproval } from './sync-message-templates/twilio-client';
import { computePlan, ApprovedTwilioEntry } from './sync-message-templates/diff-engine';
import { applyPlan, fetchDbTemplates } from './sync-message-templates/db';
import { printPlan } from './sync-message-templates/plan-printer';

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`
Usage: ts-node -r dotenv/config scripts/sync-message-templates-twilio.ts [options]

Options:
  --dry-run                   Compute and print plan; do not write (default if --apply absent).
  --apply                     Execute plan against the DB.
  --include-unapproved        Treat any Twilio Content as valid (skip WhatsApp approval check).
  --allow-hardcoded-delete    Allow DELETE of slugs hardcoded in source code (dangerous).
  --help                      Print this message.

Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
`);
  process.exit(0);
}

const apply = args.includes('--apply');
const includeUnapproved = args.includes('--include-unapproved');
const allowHardcodedDelete = args.includes('--allow-hardcoded-delete');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error('[sync] TWILIO_ACCOUNT_SID e TWILIO_AUTH_TOKEN obrigatórios no env.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('[sync] DATABASE_URL obrigatório no env.');
  process.exit(1);
}

// ── Filtro de approval ────────────────────────────────────────────────────────
async function collectApprovedTwilio(
  client: TwilioContentClient,
  contents: TwilioContent[],
): Promise<ApprovedTwilioEntry[]> {
  if (includeUnapproved) {
    return contents.map(content => ({ content, approval: null }));
  }
  const result: ApprovedTwilioEntry[] = [];
  for (const content of contents) {
    const approval: WhatsAppApproval | null = await client.fetchWhatsAppApproval(content.sid);
    if (approval?.status === 'approved') result.push({ content, approval });
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`[sync] modo: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  if (includeUnapproved) {
    console.log('[sync] --include-unapproved: pulando checagem de approval WhatsApp');
  }

  const twilio = new TwilioContentClient(TWILIO_ACCOUNT_SID!, TWILIO_AUTH_TOKEN!);
  console.log('[sync] fetching Twilio Contents…');
  const allContents = await twilio.fetchAllContents();
  console.log(`[sync] ${allContents.length} Contents encontrados na Twilio.`);

  const approvedTwilio = await collectApprovedTwilio(twilio, allContents);
  console.log(`[sync] ${approvedTwilio.length} aprovados (ou todos se --include-unapproved).`);

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const dbRows = await fetchDbTemplates(pool);
    console.log(`[sync] ${dbRows.length} rows em message_templates no banco.`);

    const plan = computePlan(approvedTwilio, dbRows);
    printPlan(plan);

    const hardcodedInDelete = plan.deletes.filter(d => HARDCODED_SLUGS.has(d.slug));
    if (hardcodedInDelete.length > 0 && !allowHardcodedDelete) {
      console.error('[sync] ABORT: hardcoded slugs no plano de DELETE. Use --allow-hardcoded-delete pra forçar.');
      process.exit(2);
    }

    if (!apply) {
      console.log('[sync] dry-run — nenhuma mudança aplicada. Use --apply pra executar.');
      return;
    }

    await applyPlan(pool, plan);
    console.log(`[sync] DONE. inserts=${plan.inserts.length} updates=${plan.updates.length} deletes=${plan.deletes.length}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[sync] erro fatal:', err);
  process.exit(1);
});
