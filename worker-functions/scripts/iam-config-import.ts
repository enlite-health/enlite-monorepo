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
 * Uso:  DATABASE_URL=<alvo> npm run iam:config:import:dry -- --file iam-config.json --actor-email gestor@enlite.health [--tenant <uuid>]
 *       DATABASE_URL=<alvo> npm run iam:config:import     -- --file iam-config.json --actor-email ... [--archive-missing] [--tenant <uuid>]
 *
 * TENANT (M5/M4): `current` é exportado do tenant que o BANCO-ALVO efetivamente
 * serve — `--tenant <uuid>` se dado, senão `repo.resolveTenantId()` (→
 * `iam.current_tenant_id()`) —, NUNCA de `desired.tenantId` — senão a guarda
 * `tenant_mismatch` do planner é inerte (comparar um valor com ele mesmo nunca
 * diverge). `--tenant` existe porque `resolveTenantId()` num `pg.Pool` cru sem
 * GUC de sessão só enxerga o tenant único da mig 206 — ver o docstring de
 * `resolveTenantId` para o que essa guarda pega e o que não pega.
 *
 * PII (B4): nenhum e-mail sai cru em `console.*` — todo e-mail impresso passa
 * por `maskEmail` (`mask`), inclusive nos erros do plano.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import { Pool } from 'pg';
import { PgIamConfigRepository } from '@modules/identity/permissions/infrastructure/PgIamConfigRepository';
import { planIamConfigImport, snapshotHash, type IamConfigSnapshot } from '@modules/identity/permissions/application/iamConfig';
import { argValue } from './lib/cliArgs';
import { maskEmail as mask } from './lib/maskEmail';

const EXECUTE = process.argv.includes('--execute');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const file = argValue('--file');
  const actorEmail = argValue('--actor-email');
  if (!url || !file || !actorEmail) throw new Error('DATABASE_URL, --file e --actor-email são obrigatórios');

  const desired = JSON.parse(readFileSync(file, 'utf8')) as IamConfigSnapshot;
  const pool = new Pool({ connectionString: url });
  try {
    const repo = new PgIamConfigRepository(pool);
    // M4: `--tenant` tem prioridade — senão o tenant do ALVO vem do banco, não
    // do JSON (M5, inalterado): senão `current.tenantId` é sempre igual a
    // `desired.tenantId` por construção, e a guarda nunca dispara.
    const targetTenantId = argValue('--tenant') ?? (await repo.resolveTenantId());
    const [current, catalog, staffUids, anyUids, actorUid, archivedGroupNames] = await Promise.all([
      repo.exportSnapshot(targetTenantId),
      repo.liveCells(),
      repo.staffUidsByEmail(),
      repo.uidsByEmailAny(), // M1: `removableEmails` do planner — SEM filtro de role
      repo.uidByEmail(actorEmail),
      repo.archivedGroupNames(targetTenantId),
    ]);
    const plan = planIamConfigImport(desired, {
      current,
      catalog,
      knownEmails: new Set(staffUids.keys()),
      removableEmails: new Set(anyUids.keys()),
      archivedGroupNames,
    }, {
      archiveMissing: process.argv.includes('--archive-missing'),
    });

    console.log(`[iam-config] ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} · arquivo=${basename(file)}@${snapshotHash(desired)} · ops=${plan.ops.length} · erros=${plan.errors.length} · pendências=${plan.pendencies.length}`);
    for (const op of plan.ops) {
      const alvo = 'email' in op ? mask(op.email) : 'featureKey' in op ? `${op.country}/${op.featureKey}` : 'country' in op ? op.country : '';
      console.log(`  ${op.kind.padEnd(20)} ${'group' in op ? op.group : ''} ${alvo}`.trimEnd());
    }
    for (const p of plan.pendencies) console.log(`  [pendência] ${p.code} ${mask(p.email)} → ${p.group}`);
    // B4: `detail` não carrega e-mail — o campo estruturado `email` (quando
    // presente) é o que vai mascarado; nunca `e.detail` cru.
    for (const e of plan.errors) console.error(`  [ERRO] ${e.code}: ${e.detail}${e.email ? ` (${mask(e.email)})` : ''}`);

    if (plan.errors.length > 0) { process.exitCode = 1; return; }
    if (!actorUid) throw new Error(`ator ${mask(actorEmail)} não tem conta no alvo`);
    if (!EXECUTE) return;

    const n = await repo.applyPlan(plan, { tenantId: targetTenantId, actorUid, reason: `iam-config import ${basename(file)}@${snapshotHash(desired)}` });
    console.log(`[iam-config] aplicadas ${n} operações como ${mask(actorEmail)}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error('[iam-config] falhou:', e.message); process.exit(1); });
