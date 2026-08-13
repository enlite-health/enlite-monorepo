/**
 * Prova de produção: roda GetFunnelByWorkerUseCase (o código real, não uma
 * reprodução do SQL) contra o banco de PRODUÇÃO via cloud-sql-proxy e confere as
 * invariantes do contrato.
 *
 * READ-ONLY. Uso:
 *   PGPASSWORD=... npx tsx scripts/funnel-por-prestador-proof.ts
 */
import { Pool } from 'pg';
import { GetFunnelByWorkerUseCase } from '../src/modules/matching/application/GetFunnelByWorkerUseCase';
import { GetManagementDashboardUseCase } from '../src/modules/matching/application/GetManagementDashboardUseCase';

async function main(): Promise<void> {
  const pool = new Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5435),
    database: process.env.PGDATABASE ?? 'enlite',
    user: process.env.PGUSER ?? 'enlite_admin',
    password: process.env.PGPASSWORD,
    max: 2,
  });

  const started = Date.now();
  const result = await new GetFunnelByWorkerUseCase(pool).execute();
  const ms = Date.now() - started;

  const somaConsolidado = Object.values(result.consolidado).reduce((a, b) => a + b, 0);
  const somaPorEtapa = Object.values(result.porEtapa).reduce((a, b) => a + b, 0);

  const patients = await pool.query<{ activos: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS activos
       FROM patients WHERE deleted_at IS NULL`,
  );

  console.log('--- funil por prestador (PRODUÇÃO) ---');
  console.log('total de prestadores :', result.total);
  console.log('consolidado          :', JSON.stringify(result.consolidado));
  console.log('  soma               :', somaConsolidado);
  console.log('por etapa            :', JSON.stringify(result.porEtapa));
  console.log('  soma               :', somaPorEtapa);
  console.log('pacientesActivos     :', patients.rows[0].activos);
  console.log('tempo da query       :', `${ms}ms`);

  // Payload COMPLETO do endpoint, validado pelo Zod — é o que a tela vai receber.
  const payload = await new GetManagementDashboardUseCase(pool).execute();
  console.log('\n--- payload do endpoint (produção) ---');
  console.log(JSON.stringify(payload, null, 2));

  const invariantes = [
    ['consolidado soma == total', somaConsolidado === result.total],
    ['por etapa soma >= total (pessoa em várias colunas)', somaPorEtapa >= result.total],
    ['total > 0', result.total > 0],
    ['payload passa no contrato Zod', payload != null],
    [
      'pacientesActivos ignora apagados',
      payload.bigNumbers.pacientesActivos === patients.rows[0].activos,
    ],
    [
      'encuadres: semana + sem-data coerentes',
      payload.encuadres.agendadosEstaSemana >= 0 && payload.encuadres.semDataRegistrada >= 0,
    ],
  ] as const;

  let ok = true;
  for (const [nome, passou] of invariantes) {
    console.log(passou ? `✓ ${nome}` : `✗ ${nome}`);
    if (!passou) ok = false;
  }

  await pool.end();
  process.exit(ok ? 0 : 1);
}

void main();
