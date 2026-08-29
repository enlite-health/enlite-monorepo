/**
 * scripts/iam-config-import.ts — aplica um JSON de configuração IAM num banco-alvo (D208).
 *
 * Calcula o PLANO em memória (o que difere) e o aplica SÓ pelas funções
 * SECURITY DEFINER da 279, numa transação, como o ator informado por
 * `--actor-email` — que precisa ter `permission_management:write` no alvo (senão
 * 42501 e nada aplicado). Célula que o alvo não conhece = erro, nada aplicado.
 * E-mail sem conta no alvo = pendência listada, membro pulado. Grupo ausente do
 * JSON é mantido; `--archive-missing` arquiva só os não-sistema. Idempotente:
 * `--execute` 2× → 0 operações na 2ª.
 *
 * Uso:  DATABASE_URL=<alvo> npm run iam:config:import:dry -- --file iam-config.json --actor-email gestor@enlite.health
 *       DATABASE_URL=<alvo> npm run iam:config:import     -- --file iam-config.json --actor-email ... [--archive-missing]
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import { Pool } from 'pg';
import { PgIamConfigRepository } from '@modules/identity/permissions/infrastructure/PgIamConfigRepository';
import { planIamConfigImport, snapshotHash, type IamConfigSnapshot } from '@modules/identity/permissions/application/iamConfig';

const EXECUTE = process.argv.includes('--execute');
const mask = (e: string) => e.replace(/^(..).*@/, '$1…@');
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const file = argValue('--file');
  const actorEmail = argValue('--actor-email');
  if (!url || !file || !actorEmail) throw new Error('DATABASE_URL, --file e --actor-email são obrigatórios');

  const desired = JSON.parse(readFileSync(file, 'utf8')) as IamConfigSnapshot;
  const pool = new Pool({ connectionString: url });
  try {
    const repo = new PgIamConfigRepository(pool);
    const [current, catalog, uids, actorUid] = await Promise.all([
      repo.exportSnapshot(desired.tenantId),
      repo.liveCells(),
      repo.staffUidsByEmail(),
      repo.uidByEmail(actorEmail),
    ]);
    const plan = planIamConfigImport(desired, { current, catalog, knownEmails: new Set(uids.keys()) }, {
      archiveMissing: process.argv.includes('--archive-missing'),
    });

    console.log(`[iam-config] ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} · arquivo=${basename(file)}@${snapshotHash(desired)} · ops=${plan.ops.length} · erros=${plan.errors.length} · pendências=${plan.pendencies.length}`);
    for (const op of plan.ops) {
      const alvo = 'email' in op ? mask(op.email) : 'featureKey' in op ? `${op.country}/${op.featureKey}` : 'country' in op ? op.country : '';
      console.log(`  ${op.kind.padEnd(20)} ${'group' in op ? op.group : ''} ${alvo}`.trimEnd());
    }
    for (const p of plan.pendencies) console.log(`  [pendência] ${p.code} ${mask(p.email)} → ${p.group}`);
    for (const e of plan.errors) console.error(`  [ERRO] ${e.code}: ${e.detail}`);

    if (plan.errors.length > 0) { process.exitCode = 1; return; }
    if (!actorUid) throw new Error(`ator ${mask(actorEmail)} não tem conta no alvo`);
    if (!EXECUTE) return;

    const n = await repo.applyPlan(plan, { tenantId: desired.tenantId, actorUid, reason: `iam-config import ${basename(file)}@${snapshotHash(desired)}` });
    console.log(`[iam-config] aplicadas ${n} operações como ${mask(actorEmail)}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error('[iam-config] falhou:', e.message); process.exit(1); });
