/**
 * talentum-repontar-vaga-dona.ts — M2 (auditoria Talentum→card, 04/11): repontar `talentum_prescreenings.job_posting_id`
 * para a vaga DONA do `talentum_prescreening_id` (a vaga viva com `job_postings.talentum_prescreening_id` igual) e
 * reaplicar a etapa como o `syncFunnel` faria — SEM mensagem (nenhum `domain_events`, nenhum Pub/Sub, nenhuma chamada outbound).
 *
 * O Talentum é a fonte da verdade e o card o ESPELHO: o script só alinha o card à vaga dona, não inventa régua de score.
 *
 * Reaplicar a etapa = inserir o `worker_job_applications` na vaga dona SE AINDA NÃO EXISTE (INSERT … ON CONFLICT DO NOTHING).
 * Se já existe, não toca: um "Mover a…" da staff nunca é revertido. Etapa a partir do status gravado:
 * INITIATED→PRE_SCREENING, NOT_QUALIFIED→REJECTED, PENDING→(nada, como o syncFunnel), demais iguais. match_score fica 0
 * (o score não é gravado em `talentum_prescreenings`; o próximo evento do Talentum o atualiza). O encuadre NÃO é criado aqui
 * (precisa do nome/telefone do payload, que não está no banco): o próximo evento do webhook o cria.
 * O WJA/encuadre antigo na vaga errada NÃO é removido (decisão humana) — só contado no relatório.
 *
 * (M5 — backfill do `talentum_prescreening_id` das vagas sem id — já existe: `scripts/backfill-talentum-prescreening-id.ts`
 * com --dry-run/--apply; rode-o ANTES deste, pois a dona só existe depois do backfill.)
 *
 * Uso (NÃO rodado em prd por este PR):
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/talentum-repontar-vaga-dona.ts --dry-run
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register scripts/talentum-repontar-vaga-dona.ts --apply
 * `--dry-run` executa tudo numa transação por linha e dá ROLLBACK. Saída: só ids e contagens (sem PII).
 */
import { Pool } from 'pg';

export type Mode = 'dry-run' | 'apply';

export function parseMode(argv: string[]): Mode {
  const dry = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  if (dry === apply) throw new Error('uso: talentum-repontar-vaga-dona (--dry-run | --apply) — exatamente um dos dois');
  return apply ? 'apply' : 'dry-run';
}

/** Etapa do funil a partir do status gravado (espelha `deriveFunnelStage` + `NOT_QUALIFIED→REJECTED`). `null` = não grava WJA. */
export function stageFromStatus(status: string): string | null {
  if (status === 'PENDING') return null;
  if (status === 'INITIATED') return 'PRE_SCREENING';
  if (status === 'NOT_QUALIFIED') return 'REJECTED';
  return status;
}

const MISMATCH_SQL = `
  SELECT tp.id, tp.worker_id, tp.job_posting_id AS stored, jp.id AS owner, tp.status
  FROM talentum_prescreenings tp
  JOIN job_postings jp ON jp.talentum_prescreening_id = tp.talentum_prescreening_id AND jp.deleted_at IS NULL
  WHERE tp.environment = 'production' AND tp.job_posting_id IS DISTINCT FROM jp.id
  ORDER BY tp.id`;

interface Row { id: string; worker_id: string | null; stored: string | null; owner: string; status: string }

export async function run(pool: Pool, mode: Mode, log: (l: string) => void): Promise<{ repointed: number; wjaInserted: number; oldWjaLeft: number; errors: string[] }> {
  const rows = (await pool.query<Row>(MISMATCH_SQL)).rows;
  log(`${mode.toUpperCase()} — prescreenings fora da vaga dona=${rows.length}`);
  let repointed = 0, wjaInserted = 0, oldWjaLeft = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE talentum_prescreenings SET job_posting_id = $1, updated_at = NOW() WHERE id = $2', [r.owner, r.id]);
      repointed += 1;
      const stage = r.worker_id ? stageFromStatus(r.status) : null;
      if (r.worker_id && stage) {
        const ins = await client.query(
          `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, match_score, source)
           VALUES ($1, $2, $3, 0, 'talentum') ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
          [r.worker_id, r.owner, stage],
        );
        wjaInserted += ins.rowCount ?? 0;
      }
      if (r.worker_id && r.stored) {
        const old = await client.query('SELECT 1 FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2', [r.worker_id, r.stored]);
        oldWjaLeft += old.rowCount ?? 0;
      }
      await client.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      errors.push(`${r.id}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  log(`reapontadas=${repointed} | WJA inseridos na dona=${wjaInserted} | WJA antigo mantido na vaga errada (decisão humana)=${oldWjaLeft} | erros=${errors.length}`);
  for (const e of errors) log(`ERRO ${e}`);
  return { repointed, wjaInserted, oldWjaLeft, errors };
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente');
  const mode = parseMode(process.argv.slice(2));
  const pool = new Pool({ connectionString: url, max: 2 });
  run(pool, mode, (l) => console.log(l))
    .then((r) => pool.end().then(() => process.exit(r.errors.length ? 1 : 0)))
    .catch((e) => { console.error(`ERRO: ${(e as Error).message}`); process.exit(1); });
}
