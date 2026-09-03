/**
 * verificar-4.2-divergencia.ts — o escalar derivado bate com o conjunto?
 *
 * `patients.device_type` deixou de ser co-escrito e passou a ser DERIVADO de
 * `patient_device_types` pelo trigger da migration 310 (F64). Este script mede se os dois
 * concordam — e é o único jeito de saber, porque divergência aqui não gera erro, não gera log
 * e não muda o `success:true` do webhook. É a F43 aplicada a este campo.
 *
 * ⚠️ Por que ele NÃO compara "duas cópias da mesma suposição": a régua é a definição do
 * trigger recalculada AGORA, contra o valor persistido. Se alguém reintroduzir uma escrita
 * direta no escalar, os dois divergem e este número sobe. Um teste que comparasse o teto do
 * SQL com o teto do TypeScript garantiria só que eles concordam entre si — foi o erro medido
 * na Fase 4 e está no `HANDOFF-fases-4-5.md`.
 *
 * MODOS
 *   (sem argumento)  mede o banco de `DATABASE_URL` e imprime CONTAGENS
 *   --autoteste      prova o instrumento ANTES de tocar dado real: cria divergência de
 *                    propósito e exige que o script a DETECTE; depois conserta e exige zero.
 *                    Roda inteiro em transação e faz ROLLBACK.
 *
 * 🔒 Nada de PII ou de rótulo clínico sai daqui: só números e códigos de catálogo agregados.
 *    (`INPATIENT`/`INSTITUTIONAL` revelam regime de cuidado — por isso NÃO se imprime a
 *    associação paciente↔código, apenas a contagem por código.)
 */
import { Pool, PoolClient } from 'pg';

/** A definição do trigger, em uma query: o que o escalar DEVERIA ser, para cada paciente. */
const DIVERGENTES = `
  SELECT count(*)::int AS n
    FROM patients p
   WHERE p.device_type IS DISTINCT FROM (
     SELECT pdt.device_type
       FROM patient_device_types pdt
       JOIN device_types d ON d.code = pdt.device_type
      WHERE pdt.patient_id = p.id
      ORDER BY d.sort_order, d.code
      LIMIT 1
   )`;

async function contarDivergentes(c: PoolClient): Promise<number> {
  return (await c.query<{ n: number }>(DIVERGENTES)).rows[0].n;
}

async function medir(c: PoolClient): Promise<void> {
  const div = await contarDivergentes(c);
  const tot = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM patients`)).rows[0].n;
  const comConjunto = (await c.query<{ n: number }>(
    `SELECT count(DISTINCT patient_id)::int n FROM patient_device_types`)).rows[0].n;
  const comEscalar = (await c.query<{ n: number }>(
    `SELECT count(*)::int n FROM patients WHERE device_type IS NOT NULL`)).rows[0].n;
  const porCodigo = await c.query<{ device_type: string; n: number }>(
    `SELECT device_type, count(*)::int n FROM patient_device_types GROUP BY device_type ORDER BY 2 DESC`);

  console.log(`pacientes ................... ${tot}`);
  console.log(`com conjunto (tabela) ....... ${comConjunto}`);
  console.log(`com escalar (derivado) ...... ${comEscalar}`);
  console.log(`por código:`);
  for (const r of porCodigo.rows) console.log(`  ${r.device_type.padEnd(16)} ${r.n}`);
  console.log(`\nDIVERGENTES ................. ${div}`);
  if (div > 0) {
    console.log('\n✘ REPROVA: há paciente cujo escalar não é o que o trigger calcularia.');
    console.log('  Causa provável: alguém voltou a escrever `patients.device_type` direto');
    console.log('  (ver PatientClinicalRepository), ou o trigger da 310 não está instalado.');
    process.exitCode = 1;
  } else {
    console.log('\n✔ escalar e conjunto concordam em todos os pacientes.');
  }
}

async function autoteste(c: PoolClient): Promise<void> {
  console.log('── AUTOTESTE — provando que o instrumento DETECTA antes de medir o real ──\n');
  const pac = (await c.query<{ id: string }>(
    `INSERT INTO patients (first_name,last_name,country,is_test)
     VALUES ('S','FIXTURE-4.2','AR',true) RETURNING id`)).rows[0].id;

  const base = await contarDivergentes(c);
  console.log(`[0] divergentes com o paciente recém-criado (sem conjunto, escalar NULL): ${base}`);

  // 1. Conjunto com um tipo → o trigger deve preencher o escalar. Zero divergência.
  await c.query(`INSERT INTO patient_device_types (patient_id, device_type, source) VALUES ($1,'SCHOOL','autoteste')`, [pac]);
  const escalar1 = (await c.query<{ v: string | null }>(`SELECT device_type v FROM patients WHERE id=$1`, [pac])).rows[0].v;
  const d1 = await contarDivergentes(c);
  console.log(`[1] após INSERT de SCHOOL → escalar=${JSON.stringify(escalar1)} · divergentes=${d1}  (esperado "SCHOOL" e ${base})`);

  // 2. SABOTAGEM: escreve o escalar direto, como faria um repositório que voltou a co-escrever.
  //    O script TEM de acusar. Se não acusar, ele não mede nada e o resto é teatro.
  await c.query(`UPDATE patients SET device_type='TRANSPORT' WHERE id=$1`, [pac]);
  const d2 = await contarDivergentes(c);
  console.log(`[2] SABOTADO (escalar escrito à mão) → divergentes=${d2}  (esperado ${base + 1})`);

  // 3. Conserto: reaplica a regra do trigger tocando o conjunto.
  await c.query(`DELETE FROM patient_device_types WHERE patient_id=$1`, [pac]);
  await c.query(`INSERT INTO patient_device_types (patient_id, device_type, source) VALUES ($1,'SCHOOL','autoteste')`, [pac]);
  const d3 = await contarDivergentes(c);
  console.log(`[3] após reescrever o CONJUNTO → divergentes=${d3}  (esperado ${base})`);

  // 4. Desempate: dois tipos, o escalar tem de ser o de menor sort_order (HOME=1 < SCHOOL=2).
  await c.query(`INSERT INTO patient_device_types (patient_id, device_type, source) VALUES ($1,'HOME','autoteste')`, [pac]);
  const escalar4 = (await c.query<{ v: string | null }>(`SELECT device_type v FROM patients WHERE id=$1`, [pac])).rows[0].v;
  console.log(`[4] conjunto {SCHOOL, HOME} → escalar=${JSON.stringify(escalar4)}  (esperado "HOME", sort_order 1)`);

  // 5. Conjunto esvaziado → escalar volta a NULL, sem sobrar valor órfão.
  await c.query(`DELETE FROM patient_device_types WHERE patient_id=$1`, [pac]);
  const escalar5 = (await c.query<{ v: string | null }>(`SELECT device_type v FROM patients WHERE id=$1`, [pac])).rows[0].v;
  console.log(`[5] conjunto vazio → escalar=${JSON.stringify(escalar5)}  (esperado null)`);

  const ok =
    escalar1 === 'SCHOOL' && d1 === base &&
    d2 === base + 1 &&
    d3 === base &&
    escalar4 === 'HOME' &&
    escalar5 === null;

  console.log(`\n${ok ? '✔ AUTOTESTE 6/6 — o instrumento detecta a sabotagem e a regra de desempate vale.'
                     : '✘ AUTOTESTE REPROVOU — não use este script para medir nada.'}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  const auto = process.argv.includes('--autoteste');
  try {
    if (auto) {
      await c.query('BEGIN');
      await autoteste(c);
      await c.query('ROLLBACK');   // nada persiste: o autoteste não suja banco nenhum
    } else {
      await medir(c);
    }
  } finally {
    c.release();
    await pool.end();
  }
})();
