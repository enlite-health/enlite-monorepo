/**
 * bulk-archive-stale-workers-2026-01-30.ts
 *
 * Arquiva (status='DISABLED' + opt-out formal) workers cujo histórico de
 * recrutamento é inteiramente anterior a 2026-01-30 — decisão do dono do
 * produto para limpar Kanban/Gestão à Vista de registros sem valor operacional.
 *
 * NÃO deleta fisicamente: reversível (ver seção de rollback no plano). Rejeitado
 * anteriormente um DELETE físico do mesmo escopo (diario.md 08/08) por colidir
 * com messaging_opt_out (Ley 25.326) e merge de contas — este script preserva os
 * dois.
 *
 * Critério de elegibilidade (worker):
 *   - tem >=1 linha em encuadres
 *   - NENHUMA dessas linhas tem recruitment_date >= 2026-01-30
 *     (cobre < 2026-01-30, sentinela 2000-01-01, e NULL automaticamente — ver
 *     nota da query)
 *   - merged_into_id IS NULL (não é registro já mergeado)
 *   - status <> 'DISABLED' (já desativado, sem ação)
 *   - ana_care_status NOT IN ('Activo', 'Cubriendo guardias') ou NULL
 *     (exclusão de segurança: pode estar cobrindo paciente agora)
 *
 * Uso:
 *   npm run archive:stale-workers:dry            # só lista + CSV, não escreve
 *   npm run archive:stale-workers                # escreve de verdade (status + opt-out)
 *   npx ts-node ... --rollback <csv-path>         # reverte a partir do CSV exportado
 *
 * Pré-requisito: rodar SÓ DEPOIS do deploy do fix em WJAFunnelController.ts
 * (senão o Kanban de vaga específica continua mostrando quem foi arquivado).
 *
 * Sobre o rollback — por que é POR LINHA (savepoint), não um UPDATE em massa:
 * `fn_guard_registered_status` (migration 212) bloqueia qualquer UPDATE que
 * tente colocar um worker de volta em REGISTERED se faltar campo obrigatório
 * (nome, documento, endereço de atendimento etc). Ele só dispara em UPDATE, não
 * em INSERT — então um worker inserido diretamente via import (exatamente o
 * perfil desta operação) pode estar com status='REGISTERED' hoje sem nunca ter
 * passado por essa validação. Confirmado em prod (10/08): 18 dos elegíveis
 * REGISTERED têm documentos faltando. Um UPDATE set-based único falharia por
 * inteiro no primeiro desses casos — por isso cada linha roda sob SAVEPOINT
 * próprio: quem não pode voltar a REGISTERED fica DISABLED (estado seguro) e
 * entra na lista de falhas para revisão manual, sem travar o resto do lote.
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const rollbackFlagIndex = process.argv.indexOf('--rollback');
const rollbackCsvPath = rollbackFlagIndex >= 0 ? process.argv[rollbackFlagIndex + 1] : null;
const isDryRun = !process.argv.includes('--execute');
const JOB_ID = 'bulk-archive-stale-2026-01-30';
const OPT_OUT_SOURCE = 'bulk_archive_stale_2026_01_30';
const CUTOFF_DATE = '2026-01-30';

interface EligibleRow {
  worker_id: string;
  status_before: string;
  ana_care_status: string | null;
  encuadres_count: number;
  most_recent_recruitment_date: string | null;
  has_phone: boolean;
}

const ELIGIBILITY_QUERY = `
  WITH eligible AS (
    SELECT w.id
    FROM workers w
    WHERE w.merged_into_id IS NULL
      AND w.status <> 'DISABLED'
      AND (w.ana_care_status IS NULL OR w.ana_care_status NOT IN ('Activo', 'Cubriendo guardias'))
      AND EXISTS (SELECT 1 FROM encuadres e WHERE e.worker_id = w.id)
      AND NOT EXISTS (
        SELECT 1 FROM encuadres e
        WHERE e.worker_id = w.id AND e.recruitment_date >= $1::date
      )
  )
  SELECT
    w.id AS worker_id,
    w.status AS status_before,
    w.ana_care_status,
    (SELECT COUNT(*) FROM encuadres e WHERE e.worker_id = w.id)::int AS encuadres_count,
    (SELECT MAX(e.recruitment_date) FROM encuadres e WHERE e.worker_id = w.id) AS most_recent_recruitment_date,
    (w.phone IS NOT NULL) AS has_phone
  FROM workers w
  JOIN eligible el ON el.id = w.id
  ORDER BY w.id;
`;
// NOT EXISTS (... recruitment_date >= cutoff) já cobre "< cutoff", sentinela
// 2000-01-01 e NULL como "antigo" automaticamente — NULL >= data avalia UNKNOWN,
// nunca TRUE, então a linha nunca "conta" para o EXISTS interno.

/**
 * pg devolve DATE como objeto Date à meia-noite LOCAL — usar métodos locais
 * (não toISOString/UTC) para não deslocar o dia conforme o fuso da máquina.
 */
function formatDateOnly(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function writeCsv(rows: EligibleRow[], exportedAt: string): string {
  const outDir = path.join(__dirname, 'bulk-archive-output');
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `bulk-archive-stale-workers-${exportedAt.replace(/[:.]/g, '-')}.csv`);
  const header = 'worker_id,status_before,ana_care_status,encuadres_count,most_recent_recruitment_date,has_phone,exported_at';
  const lines = rows.map((r) =>
    [
      r.worker_id,
      r.status_before,
      r.ana_care_status ?? '',
      r.encuadres_count,
      formatDateOnly(r.most_recent_recruitment_date),
      r.has_phone,
      exportedAt,
    ].join(','),
  );
  fs.writeFileSync(filePath, [header, ...lines].join('\n') + '\n');
  return filePath;
}

interface RollbackRow {
  worker_id: string;
  status_before: string;
}

/** CSV é escrito só por writeCsv acima (colunas fixas, sem texto livre) — split simples é seguro. */
function readCsv(filePath: string): RollbackRow[] {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  const [, ...lines] = content.split('\n');
  return lines.filter(Boolean).map((line) => {
    const [worker_id, status_before] = line.split(',');
    return { worker_id, status_before };
  });
}

async function runRollback(pool: Pool, csvPath: string): Promise<void> {
  const rows = readCsv(csvPath);
  console.log(`[bulk-archive] rollback: ${rows.length} linhas lidas de ${csvPath}`);

  const reverted: string[] = [];
  const failed: Array<{ workerId: string; reason: string }> = [];

  await withActorContext(
    pool,
    async (client) => {
      for (const row of rows) {
        await client.query('SAVEPOINT sp_rollback_row');
        try {
          const updateResult = await client.query(
            `UPDATE workers SET status = $2, updated_at = NOW()
             WHERE id = $1 AND status = 'DISABLED'
             RETURNING id`,
            [row.worker_id, row.status_before],
          );
          if (updateResult.rows.length === 0) {
            // Já não estava DISABLED (rollback rodado 2x, ou alterado por outra via) — não é erro.
            await client.query('RELEASE SAVEPOINT sp_rollback_row');
            continue;
          }
          await client.query(
            `UPDATE messaging_opt_out SET opted_in_at = NOW()
             WHERE worker_id = $1 AND source = $2`,
            [row.worker_id, OPT_OUT_SOURCE],
          );
          await client.query('RELEASE SAVEPOINT sp_rollback_row');
          reverted.push(row.worker_id);
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT sp_rollback_row');
          failed.push({ workerId: row.worker_id, reason: (err as Error).message });
        }
      }
    },
    systemActor(`${JOB_ID}-rollback`),
  );

  console.log(`[bulk-archive] rollback DONE — revertidos=${reverted.length} falharam=${failed.length}`);
  if (failed.length > 0) {
    console.log('[bulk-archive] falharam (seguem DISABLED — revisar manualmente, provável campo obrigatório faltando):');
    failed.forEach((f) => console.log(`  ${f.workerId} — ${f.reason}`));
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  if (rollbackCsvPath) {
    await runRollback(pool, rollbackCsvPath);
    await pool.end();
    return;
  }

  await runArchive(pool);
  await pool.end();
}

async function runArchive(pool: Pool): Promise<void> {
  console.log(`[bulk-archive] mode=${isDryRun ? 'DRY RUN (--execute para escrever)' : 'EXECUTE'} cutoff=${CUTOFF_DATE}`);

  const { rows } = await pool.query<EligibleRow>(ELIGIBILITY_QUERY, [CUTOFF_DATE]);
  console.log(`[bulk-archive] elegíveis: ${rows.length}`);

  const withoutPhone = rows.filter((r) => !r.has_phone).length;
  const anaCareTagged = rows.filter((r) => r.ana_care_status).length;
  console.log(`[bulk-archive] breakdown: sem_telefone=${withoutPhone} com_ana_care_status_presente(não-alocado)=${anaCareTagged}`);

  const exportedAt = new Date().toISOString();
  const csvPath = writeCsv(rows, exportedAt);
  console.log(`[bulk-archive] CSV escrito: ${csvPath}`);
  console.log('[bulk-archive] IMPORTANTE: copie este CSV para um local durável fora do laptop antes de rodar --execute — é o único mecanismo de rollback.');

  if (isDryRun) {
    console.log('[bulk-archive] DRY RUN — nada foi alterado no banco.');
    return;
  }

  if (rows.length === 0) {
    console.log('[bulk-archive] Nenhum worker elegível — nada a fazer.');
    return;
  }

  const ids = rows.map((r) => r.worker_id);

  const { updated, optOutInserted } = await withActorContext(
    pool,
    async (client) => {
      const updateResult = await client.query(
        `UPDATE workers SET status = 'DISABLED', updated_at = NOW()
         WHERE id = ANY($1::uuid[]) AND status <> 'DISABLED'
         RETURNING id`,
        [ids],
      );

      const optOutResult = await client.query(
        `INSERT INTO messaging_opt_out (worker_id, phone, reason, source)
         SELECT id, phone, 'admin', $2
         FROM workers WHERE id = ANY($1::uuid[]) AND phone IS NOT NULL
         ON CONFLICT (worker_id) DO UPDATE SET
           opted_out_at = NOW(), opted_in_at = NULL,
           reason = EXCLUDED.reason, source = EXCLUDED.source
         RETURNING worker_id`,
        [ids, OPT_OUT_SOURCE],
      );

      return { updated: updateResult.rows.length, optOutInserted: optOutResult.rows.length };
    },
    systemActor(JOB_ID),
  );

  console.log(
    `[bulk-archive] DONE — updated=${updated} optOutInserted=${optOutInserted} optOutSkippedNoPhone=${withoutPhone}`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[bulk-archive] FATAL:', err);
    process.exit(1);
  });
}
