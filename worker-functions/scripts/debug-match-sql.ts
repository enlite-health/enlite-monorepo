/**
 * Debug — roda o SQL exato do hardFilter via mesma conexão do MatchmakingService
 * pra entender por que retorna 0 enquanto query manual via psql retorna 4.
 */
import { DatabaseConnection } from '../src/shared/database/DatabaseConnection';

async function main(): Promise<void> {
  const pool = DatabaseConnection.getInstance().getPool();

  // Teste 1: confirma que JSONB ? funciona via parameter binding
  const t1 = await pool.query(
    `SELECT $1::JSONB AS as_jsonb, ($1::JSONB) ? 'AT' AS contains_at`,
    [JSON.stringify(['AT'])],
  );
  console.log('test 1 (jsonb ? operator):', t1.rows[0]);

  // Teste 2: SQL filter sem GROUP BY (usa $1-$5)
  const t2 = await pool.query(
    `SELECT w.id AS worker_id, w.occupation, wsa.latitude, wsa.longitude
     FROM workers w
     LEFT JOIN blacklist bl ON bl.worker_id = w.id
     LEFT JOIN worker_service_areas wsa ON wsa.worker_id = w.id AND wsa.deleted_at IS NULL
     WHERE w.merged_into_id IS NULL
       AND w.status = 'REGISTERED'
       AND w.deleted_at IS NULL
       AND bl.id IS NULL
       AND ($1::JSONB IS NULL OR $1::JSONB ? w.occupation)
       AND ($2::BOOLEAN = false OR wsa.location IS NULL OR ST_DWithin(wsa.location, ST_MakePoint($3::FLOAT, $4::FLOAT)::geography, $5::FLOAT * 1000))`,
    [
      JSON.stringify(['AT']),
      true,
      -58.5049847,
      -34.5062324,
      30,
    ],
  );
  console.log(`test 2 (hardFilter SQL sem GROUP BY): ${t2.rows.length} rows`);
  t2.rows.forEach((r) => console.log(`  ${r.worker_id} occupation=${r.occupation} lat=${r.latitude} lng=${r.longitude}`));

  // Teste 3: SQL exato copiado do MatchmakingService.hardFilter
  const t3 = await pool.query(
    `SELECT
         w.id AS worker_id,
         w.occupation,
         wsa.work_zone,
         wsa.latitude AS worker_lat,
         wsa.longitude AS worker_lng,
         (
           SELECT COALESCE(json_agg(json_build_object('case_number', jp2.case_number, 'schedule_text', jp2.schedule_days_hours)), '[]'::json)
           FROM encuadres ea JOIN job_postings jp2 ON jp2.id = ea.job_posting_id
           WHERE ea.worker_id = w.id AND ea.resultado = 'SELECCIONADO' AND jp2.is_covered = false
         ) AS active_cases
       FROM workers w
       LEFT JOIN blacklist bl ON bl.worker_id = w.id
       LEFT JOIN worker_service_areas wsa ON wsa.worker_id = w.id AND wsa.deleted_at IS NULL
       WHERE w.merged_into_id IS NULL
         AND w.status = 'REGISTERED'
         AND w.deleted_at IS NULL
         AND bl.id IS NULL
         AND ($2::JSONB IS NULL OR $2::JSONB ? w.occupation)
         AND (NOT $3::BOOLEAN OR wsa.location IS NULL OR ST_DWithin(wsa.location, ST_MakePoint($4::FLOAT, $5::FLOAT)::geography, $6::FLOAT * 1000))
         AND (NOT $7::BOOLEAN OR NOT EXISTS (SELECT 1 FROM encuadres ea2 JOIN job_postings jp3 ON jp3.id = ea2.job_posting_id WHERE ea2.worker_id = w.id AND ea2.resultado = 'SELECCIONADO' AND jp3.is_covered = false))
       GROUP BY w.id, wsa.work_zone, wsa.address_line, wsa.interest_zone, wsa.latitude, wsa.longitude`,
    [
      'aa25bb81-2f36-424a-8496-0e56e976d781',
      JSON.stringify(['AT']),
      true,
      -58.5049847,
      -34.5062324,
      30,
      false,
    ],
  );
  console.log(`test 3 (full hardFilter SQL com GROUP BY): ${t3.rows.length} rows`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
