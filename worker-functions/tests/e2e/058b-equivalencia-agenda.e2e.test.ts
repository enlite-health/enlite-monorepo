/** 058b-equivalencia-agenda.e2e.test.ts @integration — spec 058 B1 (T223): o limite de faixa gravado pelo writer é o dia LOCAL do país
 *  (nunca a data UTC) e `horario_do_servico(D)` = `horario_do_servico(D+1)` na fronteira. Postgres real, sem mock de módulo. */
import { Pool } from 'pg';
import { criarPaciente, criarServico, DATABASE_URL, limpar, novoPool, PREFIXO_PACIENTE } from './helpers/contrato058aDb';

describe('058b equivalência da agenda — dia local × dia seguinte @integration', () => {
  let pool: Pool; let patient = ''; let service = '';

  const apagarFilhos = async (): Promise<void> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const servicos = `SELECT id FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIXO_PACIENTE}%')`;
      await c.query(`DELETE FROM contracted_service_authorization WHERE contracted_service_id IN (${servicos})`);
      await c.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (${servicos})`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    pool = novoPool();
  }, 60000);
  beforeEach(async () => { await apagarFilhos(); await limpar(pool); patient = await criarPaciente(pool, 'AR'); service = await criarServico(pool, patient); });
  afterAll(async () => {
    await apagarFilhos(); await limpar(pool); await pool.end();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
  });

  it('equivalência: relógio às 01:30 UTC — o limite gravado é o dia local e horario_do_servico(D) = horario_do_servico(D+1)', async () => {
    const { replaceServiceSlots } = await import('@modules/case/infrastructure/ServiceSlotWriter');
    const cli = await pool.connect();
    try {
      await replaceServiceSlots(cli, service, [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], 'qa058b', new Date('2026-10-10T15:00:00Z'));
      await replaceServiceSlots(cli, service, [{ dayOfWeek: 2, startTime: '09:00', durationMinutes: 120 }], 'qa058b', new Date('2026-10-19T01:30:00Z')); // 22:30 de 18/10 em AR
    } finally { cli.release(); }
    const lim = await pool.query<{ upper: string }>(`SELECT upper(valid)::text AS upper FROM patient_itinerary_slot WHERE contracted_service_id = $1 AND weekday = 1`, [service]);
    expect(lim.rows[0].upper).toBe('2026-10-18'); // ≤ D (dia local), nunca 19/10
    const lê = async (dia: string) => (await pool.query(`SELECT horario_do_servico($1, $2::date) AS s`, [service, dia])).rows[0].s;
    expect(await lê('2026-10-18')).toEqual(await lê('2026-10-19')); // a fronteira não cai entre D e D+1
  });
});
