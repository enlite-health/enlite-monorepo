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
 *
 * MARCADOR DE ROLLOUT (F12): a mig 282 documenta "quem marca `iam.rollout_state`
 * é o script da migração de dados" — hoje esse script É este (D208: a stage
 * configura, o JSON viaja por export/import; não existe outro passo de
 * migração de grupos). Por isso, depois de um `--execute` bem-sucedido, este
 * script mede staff ACTIVE sem grupo (reaproveitando
 * `AssertNoActiveStaffWithoutGroupUseCase`, o MESMO gate do boot e do runbook
 * de virada — `scripts/assert-no-staff-without-group.sql`) e só marca
 * `permission_groups_migrated = done` se a contagem for 0. `--dry` nunca
 * escreve — só relata o que marcaria. Conecta como owner (não `app_runtime`),
 * que é a role a que a 282 NÃO revoga INSERT (GRANT/REVOKE ficam só em
 * `app_runtime`/`app_system`) — ver `PgRolloutStateRepository` para a ACL.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import { Pool } from 'pg';
import { PgIamConfigRepository } from '@modules/identity/permissions/infrastructure/PgIamConfigRepository';
import { PgEffectiveAuthzRepository } from '@modules/identity/permissions/infrastructure/PgEffectiveAuthzRepository';
import { PgRolloutStateRepository } from '@modules/identity/permissions/infrastructure/PgRolloutStateRepository';
import {
  AssertNoActiveStaffWithoutGroupUseCase,
  ROLLOUT_MARKER_KEY, ROLLOUT_MARKER_DONE } from '@modules/identity/permissions/application/AssertNoActiveStaffWithoutGroupUseCase';
// Caminho ESTREITO de propósito — `@modules/identity` (o barrel) reexporta rotas
// e infra que puxam tipagem Express (`req.user`) que só compila no contexto de
// `src/index.ts`; via `ts-node` com este script como entrypoint isso quebrava o
// build (achado ao rodar o e2e). `domain/EnliteRole` é auto-contido — zero
// imports — então não carrega esse grafo.
import { STAFF_ROLES } from '@modules/identity/domain/EnliteRole';
import { planIamConfigImport, snapshotHash, type IamConfigSnapshot } from '@modules/identity/permissions/application/iamConfig';
import { argValue } from './lib/cliArgs';
import { maskEmail as mask } from './lib/maskEmail';

const EXECUTE = process.argv.includes('--execute');

/** Staff ACTIVE total (as 3 roles do painel) — só o contexto do log (F12): o
 *  gate em si é `countActiveStaffWithoutGroup`, via `AssertNoActiveStaffWithoutGroupUseCase`
 *  (não duplicado aqui). Sem isto, "0 sem grupo" fica indistinguível de
 *  "0 porque não havia ninguém para checar" no log. */
async function countActiveStaff(pool: Pool, tenantId: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE' AND role = ANY($1) AND tenant_id = $2`,
    [STAFF_ROLES as unknown as string[], tenantId],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * Mede o gate (F12) e, se `write`, grava o marcador quando coerente.
 *   · marcador já 'done'         → mantém, avisa, não recalcula nada.
 *   · staff ACTIVE sem grupo > 0 → NÃO marca; `write` também sai com código 2
 *     (⚠️ o PLANO FOI APLICADO — o 2 significa "aplicado, mas o ambiente ainda não pode
 *     ligar o engine"; um wrapper de CI não deve ler 2 como "nada aconteceu").
 *   · crash entre o apply e o marcador: re-rodar o MESMO arquivo fecha — o plano vem
 *     vazio, `applyPlan` retorna cedo e este relatório roda mesmo assim (idempotente).
 *   · 0 sem grupo                → `write` grava; `--dry` só relata o que faria.
 */
async function reportRollout(
  pool: Pool,
  tenantId: string,
  opts: { write: boolean; file?: string; desired?: IamConfigSnapshot },
): Promise<void> {
  const gate = new AssertNoActiveStaffWithoutGroupUseCase(
    new PgEffectiveAuthzRepository(pool, STAFF_ROLES),
    new PgRolloutStateRepository(pool),
  );
  const report = await gate.execute(tenantId);

  if (report.migrated) {
    console.log(`[iam-config] marcador ${ROLLOUT_MARKER_KEY} já é '${ROLLOUT_MARKER_DONE}' — mantido`);
    return;
  }
  if (report.marker !== null) {
    // Linha existe com outro valor: não é "migrado" e não se sobrescreve às cegas — alguém escreveu
    // aquilo de propósito (rollback, ensaio). Diz o valor e deixa a decisão para o operador.
    console.error(`[iam-config] marcador ${ROLLOUT_MARKER_KEY} existe com valor '${report.marker}' (≠ '${ROLLOUT_MARKER_DONE}') — não sobrescrito; decida à mão`);
    if (opts.write) process.exitCode = 2;
    return;
  }
  if (report.count > 0) {
    const prefixo = opts.write ? '' : 'DRY-RUN: ';
    console.error(`[iam-config] ${prefixo}marcador ${ROLLOUT_MARKER_KEY} NÃO marcado — ${report.count} staff ativo(s) ainda sem grupo`);
    if (opts.write) process.exitCode = 2;
    return;
  }

  const total = await countActiveStaff(pool, tenantId);
  if (!opts.write) {
    console.log(`[iam-config] DRY-RUN: marcaria ${ROLLOUT_MARKER_KEY} = ${ROLLOUT_MARKER_DONE} (${total} staff ativos, 0 sem grupo) — não grava (--dry)`);
    return;
  }
  const note = `iam-config-import ${basename(opts.file!)}@${snapshotHash(opts.desired!)} ${new Date().toISOString()}`;
  await new PgRolloutStateRepository(pool).set(ROLLOUT_MARKER_KEY, ROLLOUT_MARKER_DONE, note);
  console.log(`[iam-config] marcador ${ROLLOUT_MARKER_KEY} = ${ROLLOUT_MARKER_DONE} (${total} staff ativos, 0 sem grupo)`);
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
    if (!EXECUTE) {
      // F12: dry-run também relata o marcador — nunca escreve (`write: false`).
      await reportRollout(pool, targetTenantId, { write: false });
      return;
    }

    const n = await repo.applyPlan(plan, { tenantId: targetTenantId, actorUid, reason: `iam-config import ${basename(file)}@${snapshotHash(desired)}` });
    console.log(`[iam-config] aplicadas ${n} operações como ${mask(actorEmail)}`);

    // F12: só depois do COMMIT — `applyPlan` abre e fecha a própria transação
    // (client.release() dentro do repositório); reabrir esse escopo aqui só
    // pra estender a mesma tx quebraria "repo grava / script orquestra" por um
    // ganho que não existe — a contagem é uma leitura pós-commit, o mesmo
    // padrão que `scripts/assert-no-staff-without-group.sql` já usa (roda fora
    // de qualquer transação de escrita, direto no estado vigente).
    await reportRollout(pool, targetTenantId, { write: true, file, desired });
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error('[iam-config] falhou:', e.message); process.exit(1); });
