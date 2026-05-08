/* eslint-disable no-console */

import * as process from 'process';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { Pool } from 'pg';
import {
  TAG,
  LOCAL_ENDPOINT_DEFAULT,
  DEFAULT_DB_URL,
  GCLOUD_PROJECT,
  GCLOUD_REGION,
  GCLOUD_SERVICE,
  GCLOUD_SECRET,
  type SmokeContext,
} from './types';

// ── gcloud helpers ────────────────────────────────────────────────────────────

function gcloudExec(command: string): string {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gcloud command failed: ${command}\n  ${message}`);
  }
}

function resolveProdEndpoint(): string {
  console.log(`${TAG} Resolving Cloud Run URL via gcloud...`);
  const url = gcloudExec(
    `gcloud run services describe ${GCLOUD_SERVICE} ` +
    `--format='value(status.url)' ` +
    `--project=${GCLOUD_PROJECT} ` +
    `--region=${GCLOUD_REGION}`,
  );
  if (!url.startsWith('https://')) {
    throw new Error(`Unexpected Cloud Run URL format: "${url}"`);
  }
  return `${url}/api/webhooks/clickup/patient`;
}

function resolveProdSecret(): string {
  console.log(`${TAG} Reading HMAC secret from Secret Manager...`);
  const secret = gcloudExec(
    `gcloud secrets versions access latest ` +
    `--secret=${GCLOUD_SECRET} ` +
    `--project=${GCLOUD_PROJECT}`,
  );
  if (!secret) {
    throw new Error(`Secret Manager returned empty value for ${GCLOUD_SECRET}`);
  }
  return secret;
}

function requireProdConfirmation(): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `\n${TAG} WARNING: you are about to run smoke tests against PRODUCTION.\n` +
      `  Target: ${GCLOUD_PROJECT} / ${GCLOUD_SERVICE}\n` +
      `  This will trigger a real patient sync via the Cloud Run instance.\n` +
      `  Tem certeza? [y/N] `,
      (answer) => {
        rl.close();
        if (answer.trim().toLowerCase() === 'y') {
          resolve();
        } else {
          reject(new Error('Aborted by user.'));
        }
      },
    );
  });
}

// ── Context builders ──────────────────────────────────────────────────────────

export async function buildLocalContext(): Promise<SmokeContext> {
  const endpoint = process.env.SMOKE_TARGET_URL ?? LOCAL_ENDPOINT_DEFAULT;

  const secret = process.env.CLICKUP_WEBHOOK_SECRET;
  if (!secret) {
    console.error(`${TAG} ERROR: CLICKUP_WEBHOOK_SECRET is not set.`);
    console.error('  Run: set -a && source .env && set +a');
    process.exit(1);
  }

  const clickupApiToken = process.env.CLICKUP_API_TOKEN ?? '';
  if (!clickupApiToken) {
    console.warn(`${TAG} WARN: CLICKUP_API_TOKEN not set — Test 1 will fail at GET task step.`);
  }

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const pool = new Pool({ connectionString: databaseUrl });

  console.log(`${TAG} target=local  endpoint=${endpoint}`);
  console.log(`${TAG} db=${databaseUrl.replace(/:[^:@]+@/, ':***@')}`);

  return { endpoint, secret, clickupApiToken, pool };
}

export async function buildProdContext(): Promise<SmokeContext> {
  await requireProdConfirmation();

  const endpoint = resolveProdEndpoint();
  const secret   = resolveProdSecret();

  const clickupApiToken = process.env.CLICKUP_API_TOKEN ?? '';
  if (!clickupApiToken) {
    console.warn(`${TAG} WARN: CLICKUP_API_TOKEN not set — Test 1 will fail at GET task step.`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      `${TAG} ERROR: DATABASE_URL is not set. ` +
      `For --target prod, start Cloud SQL Proxy and set DATABASE_URL to point to Cloud SQL.`,
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  console.log(`${TAG} target=prod   endpoint=${endpoint}`);
  console.log(`${TAG} db=${databaseUrl.replace(/:[^:@]+@/, ':***@')}`);

  return { endpoint, secret, clickupApiToken, pool };
}
