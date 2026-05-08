#!/usr/bin/env ts-node
/**
 * register-clickup-webhook.ts
 *
 * Setup one-shot do webhook ClickUp → Enlite.
 *
 * ── Pre-requisites ────────────────────────────────────────────────────────────
 *   - CLICKUP_API_TOKEN no env
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   set -a && source .env && set +a
 *
 *   # Listar webhooks existentes
 *   npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts --list
 *
 *   # Registrar webhook novo (production)
 *   npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts \
 *     --endpoint https://worker-functions-xxx.run.app/api/webhooks/clickup/patient
 *
 *   # Dry-run (não chama API)
 *   npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts \
 *     --endpoint https://example.com/webhook --dry-run
 *
 *   # Deletar webhook
 *   npx ts-node -r tsconfig-paths/register scripts/register-clickup-webhook.ts \
 *     --delete <webhook_id>
 *
 * ── Output ────────────────────────────────────────────────────────────────────
 *   Em sucesso, imprime:
 *     Webhook registered
 *        ID:       <uuid>
 *        Secret:   <hex-string>   <- copiar pro Secret Manager (Etapa 9)
 *        Endpoint: <url>
 *        Events:   [taskCreated, taskUpdated, ...]
 *        List:     901304883903 (Estado de Pacientes)
 */

/* eslint-disable no-console */

import * as process from 'process';

// ── Constants ──────────────────────────────────────────────────────────────────

export const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
export const DEFAULT_TEAM_ID = '9013274709';
export const DEFAULT_LIST_ID = '901304883903';
export const DEFAULT_EVENTS: string[] = [
  'taskCreated',
  'taskUpdated',
  'taskStatusUpdated',
  'taskMoved',
  'taskDeleted',
];

const SCRIPT_TAG = '[register-clickup-webhook]';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CreateWebhookBody {
  endpoint: string;
  events: string[];
  list_id?: string;
}

export interface CreateWebhookResponse {
  id: string;
  webhook: {
    id: string;
    secret: string;
    endpoint: string;
    events: string[];
    health: { status: string };
  };
}

export interface WebhookEntry {
  id: string;
  endpoint: string;
  events: string[];
  health: { status: string; fail_count: number };
}

export interface WebhookListResponse {
  webhooks: WebhookEntry[];
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function flagValue(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const endpoint = flagValue(argv, '--endpoint');
  const eventsRaw = flagValue(argv, '--events');
  const listId = flagValue(argv, '--list-id') ?? DEFAULT_LIST_ID;
  const teamId = flagValue(argv, '--team-id') ?? DEFAULT_TEAM_ID;
  const list = hasFlag(argv, '--list');
  const deleteId = flagValue(argv, '--delete');
  const dryRun = hasFlag(argv, '--dry-run');

  const events = eventsRaw
    ? eventsRaw.split(',').map(e => e.trim()).filter(Boolean)
    : DEFAULT_EVENTS;

  return { endpoint, events, listId, teamId, list, deleteId, dryRun };
}

export interface ParsedArgs {
  endpoint: string | null;
  events: string[];
  listId: string;
  teamId: string;
  list: boolean;
  deleteId: string | null;
  dryRun: boolean;
}

// ── Validation ─────────────────────────────────────────────────────────────────

export function validateEndpoint(endpoint: string): void {
  if (!endpoint.startsWith('https://')) {
    throw new Error(
      `Endpoint must start with https:// — ClickUp rejects non-HTTPS endpoints.\n` +
      `  Got: ${endpoint}`,
    );
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function httpErrorMessage(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '<could not read body>';
  }
  return `HTTP ${res.status} ${res.statusText}\n  Body: ${body}`;
}

// ── API operations ─────────────────────────────────────────────────────────────

export async function listWebhooks(
  teamId: string,
  token: string,
): Promise<WebhookListResponse> {
  const url = `${CLICKUP_API_BASE}/team/${teamId}/webhook`;
  const res = await fetch(url, {
    headers: { Authorization: token },
  });

  if (!res.ok) {
    const msg = await httpErrorMessage(res);
    throw new Error(`Failed to list webhooks: ${msg}`);
  }

  return (await res.json()) as WebhookListResponse;
}

export async function createWebhook(
  teamId: string,
  token: string,
  body: CreateWebhookBody,
): Promise<CreateWebhookResponse> {
  const url = `${CLICKUP_API_BASE}/team/${teamId}/webhook`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await httpErrorMessage(res);
    throw new Error(`Failed to create webhook: ${msg}`);
  }

  return (await res.json()) as CreateWebhookResponse;
}

export async function deleteWebhook(
  webhookId: string,
  token: string,
): Promise<void> {
  const url = `${CLICKUP_API_BASE}/webhook/${webhookId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: token },
  });

  if (!res.ok) {
    const msg = await httpErrorMessage(res);
    throw new Error(`Failed to delete webhook ${webhookId}: ${msg}`);
  }
}

// ── Output formatters ──────────────────────────────────────────────────────────

function printWebhookTable(webhooks: WebhookEntry[]): void {
  if (webhooks.length === 0) {
    console.log('  (no webhooks registered for this team)');
    return;
  }

  console.log(`  Found ${webhooks.length} webhook(s):\n`);
  for (const wh of webhooks) {
    console.log(`  ID:       ${wh.id}`);
    console.log(`  Endpoint: ${wh.endpoint}`);
    console.log(`  Events:   ${wh.events.join(', ')}`);
    console.log(`  Health:   ${wh.health.status} (fail_count=${wh.health.fail_count})`);
    console.log('  ---');
  }
}

function printCreatedWebhook(
  resp: CreateWebhookResponse,
  endpoint: string,
  events: string[],
  listId: string,
): void {
  console.log('Webhook registered');
  console.log(`   ID:       ${resp.webhook.id}`);
  console.log(`   Secret:   ${resp.webhook.secret}`);
  console.log(`   Endpoint: ${endpoint}`);
  console.log(`   Events:   [${events.join(', ')}]`);
  console.log(`   List:     ${listId} (Estado de Pacientes)`);
  console.log('');
  console.log('WARNING: Anote o secret AGORA — nao ha como recuperar depois');
  console.log('         (precisaria deletar e recriar o webhook para obter um novo secret).');
  console.log('');
  console.log('Proximo passo: adicionar ao Secret Manager:');
  console.log(`  gcloud secrets create CLICKUP_WEBHOOK_SECRET --replication-policy=automatic`);
  console.log(`  echo -n "${resp.webhook.secret}" | gcloud secrets versions add CLICKUP_WEBHOOK_SECRET --data-file=-`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // Env validation
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    console.error(`${SCRIPT_TAG} ERROR: CLICKUP_API_TOKEN is not set in environment.`);
    console.error('  Run: set -a && source .env && set +a');
    process.exit(1);
  }

  // ── Mode: --list ────────────────────────────────────────────────────────────
  if (args.list) {
    console.log(`${SCRIPT_TAG} Listing webhooks for team ${args.teamId}...`);
    const result = await listWebhooks(args.teamId, token);
    printWebhookTable(result.webhooks);
    return;
  }

  // ── Mode: --delete ──────────────────────────────────────────────────────────
  if (args.deleteId !== null) {
    console.log(`${SCRIPT_TAG} Deleting webhook ${args.deleteId}...`);
    await deleteWebhook(args.deleteId, token);
    console.log(`Webhook ${args.deleteId} deleted.`);
    return;
  }

  // ── Mode: register (default) ────────────────────────────────────────────────
  if (!args.endpoint) {
    console.error(`${SCRIPT_TAG} ERROR: --endpoint is required when registering a webhook.`);
    console.error('  Usage: scripts/register-clickup-webhook.ts --endpoint https://...');
    console.error('  Or use --list to see existing webhooks, --delete <id> to remove one.');
    process.exit(1);
  }

  validateEndpoint(args.endpoint);

  const body: CreateWebhookBody = {
    endpoint: args.endpoint,
    events: args.events,
    list_id: args.listId,
  };

  // ── Dry-run ──────────────────────────────────────────────────────────────────
  if (args.dryRun) {
    console.log(`${SCRIPT_TAG} DRY-RUN — no API call will be made.\n`);
    console.log('POST', `${CLICKUP_API_BASE}/team/${args.teamId}/webhook`);
    console.log('Body:', JSON.stringify(body, null, 2));
    return;
  }

  // ── Live register ────────────────────────────────────────────────────────────
  console.log(`${SCRIPT_TAG} Registering webhook...`);
  const resp = await createWebhook(args.teamId, token, body);
  printCreatedWebhook(resp, args.endpoint, args.events, args.listId);
}

// Only run when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch(err => {
    console.error(`${SCRIPT_TAG} Fatal error:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
