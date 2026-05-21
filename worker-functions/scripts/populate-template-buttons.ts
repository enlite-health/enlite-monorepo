/**
 * populate-template-buttons.ts
 *
 * Popula a coluna message_templates.buttons a partir do Twilio Content API.
 * Pra cada template ativo com content_sid, busca o Content no Twilio e
 * extrai os botões quick-reply (label + payload). Resultado é gravado no
 * banco para uso pelo espelho Chatwoot do TwilioMessagingService.
 *
 * Tipos de conteúdo Twilio suportados:
 *   twilio/quick-reply  → buttons = [{label: action.title, payload: action.id}]
 *   twilio/list-picker  → buttons = items.map(...)
 *   outros (text, card, call-to-action) → buttons = null
 *
 * Uso:
 *   ts-node -r dotenv/config scripts/populate-template-buttons.ts                 # popula todos ativos
 *   ts-node -r dotenv/config scripts/populate-template-buttons.ts --dry-run       # mostra sem salvar
 *   ts-node -r dotenv/config scripts/populate-template-buttons.ts --slug X        # só um template
 *
 * Idempotente: pode ser rodado várias vezes. Sobrescreve a coluna buttons.
 *
 * Requer no .env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL
 */

import { MessageTemplateRepository } from '../src/modules/notification/infrastructure/MessageTemplateRepository';
import { TemplateButton } from '../src/modules/notification/domain/MessageTemplate';
import { DatabaseConnection } from '../src/shared/database/DatabaseConnection';
import { TwilioContentClient } from './sync-message-templates/twilio-client';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const slugIdx = args.indexOf('--slug');
const onlySlug = slugIdx >= 0 ? args[slugIdx + 1] : null;

async function main(): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('ERRO: TWILIO_ACCOUNT_SID e TWILIO_AUTH_TOKEN são obrigatórios');
    process.exit(1);
  }

  const twilioClient = new TwilioContentClient(sid, token);
  const repo = new MessageTemplateRepository();

  // requireContentSid=true: só templates com HSM aprovado (que é onde botões existem)
  const templates = await repo.findAll(true, true);
  const filtered = onlySlug ? templates.filter(t => t.slug === onlySlug) : templates;

  if (filtered.length === 0) {
    console.log(`Nenhum template ${onlySlug ? `com slug=${onlySlug}` : 'ativo com content_sid'} encontrado.`);
    await DatabaseConnection.getInstance().getPool().end();
    return;
  }

  console.log(`Processando ${filtered.length} templates${dryRun ? ' (DRY RUN)' : ''}\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const tpl of filtered) {
    const csid = tpl.contentSid!;
    process.stdout.write(`  ${tpl.slug.padEnd(40)} ${csid} ... `);
    try {
      const content = await twilioClient.fetchContent(csid);
      const buttons = extractButtons(content.types);
      if (buttons === null) {
        console.log('sem botões (text/card/cta)');
        skipped++;
        continue;
      }
      const labels = buttons.map(b => b.label).join(' | ');
      console.log(`[${labels}]`);
      if (!dryRun) {
        await repo.updateButtons(tpl.slug, buttons);
      }
      updated++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERRO: ${msg}`);
      errors++;
    }
  }

  console.log(`\nResultado: ${updated} atualizados, ${skipped} sem botões, ${errors} erros`);
  await DatabaseConnection.getInstance().getPool().end();
}

/**
 * Extrai botões quick-reply ou list-picker dos `types` retornados pelo Twilio
 * Content API. Retorna null se o template não tem botões interativos.
 */
function extractButtons(types: Record<string, unknown>): TemplateButton[] | null {
  const qr = types['twilio/quick-reply'] as { actions?: Array<{ id?: string; title?: string }> } | undefined;
  if (qr?.actions && Array.isArray(qr.actions)) {
    const buttons: TemplateButton[] = qr.actions
      .filter(a => a?.title && a?.id)
      .map(a => ({ label: String(a.title), payload: String(a.id) }));
    return buttons.length > 0 ? buttons : null;
  }

  const lp = types['twilio/list-picker'] as { items?: Array<{ id?: string; item?: string }> } | undefined;
  if (lp?.items && Array.isArray(lp.items)) {
    const buttons: TemplateButton[] = lp.items
      .filter(i => i?.item && i?.id)
      .map(i => ({ label: String(i.item), payload: String(i.id) }));
    return buttons.length > 0 ? buttons : null;
  }

  return null;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
