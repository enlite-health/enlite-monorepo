/**
 * verificar-derivado-nao-apaga.ts — o defeito ALTA da rodada 4 do QA-caça da task 2.2,
 * provado CONTRA O BANCO e não contra um dublê.
 *
 * Por que contra o banco: o apagamento não acontecia no mapper — acontecia no
 * `UPDATE patients SET clinical_specialty = $11`. Um teste com `pg` falso mede a intenção
 * do código; só o servidor mede o que fica gravado. Foi um `pg` falso que deixou a suíte
 * verde em 1985/1985 com o registro de recusa quebrado (`42703`) o dia inteiro.
 *
 * As três colunas do experimento, no MESMO paciente sintético:
 *   1. leitura possível com valor   → grava o valor          (o caminho normal)
 *   2. leitura possível e VAZIA     → grava NULL             (D-E: vazio se escreve)
 *   3. leitura IMPOSSÍVEL           → NÃO TOCA na coluna     (D167: o conserto)
 *
 * ⚠️ Escreve. Mesma trava de alvo dos outros verificadores desta fase: só Postgres local em
 * docker, alvo reconferido CONTRA O SERVIDOR depois de conectar. Paciente sintético
 * (`is_test=true`), transação encerrada em ROLLBACK.
 */

import { Pool } from 'pg';
import { assertLocalDatabaseTarget, LOCAL_DB_NAME, LOCAL_DB_PORTS } from '@shared/database/assertLocalDatabaseTarget';

let falhas = 0;
const ok = (rotulo: string, cond: boolean, detalhe: string) => {
  console.log(`${cond ? 'OK  ' : 'FALHA'} | ${rotulo} | ${detalhe}`);
  if (!cond) falhas += 1;
};

/** O UPDATE real do `PatientClinicalRepository`, reduzido à coluna em disputa. */
const UPDATE = `UPDATE patients SET
    clinical_specialty = CASE WHEN $3::boolean THEN $2 ELSE clinical_specialty END,
    updated_at = NOW()
  WHERE id = $1`;

/** O UPDATE ANTIGO, para o controle negativo: sem a bandeira, escreve sempre. */
const UPDATE_ANTIGO = `UPDATE patients SET clinical_specialty = $2, updated_at = NOW() WHERE id = $1`;

async function main(): Promise<void> {
  const alvo = assertLocalDatabaseTarget(process.env.DATABASE_URL);
  console.log(`ALVO DECLARADO (trava passou): ${alvo}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli  = await pool.connect();
  try {
    const m = await cli.query<{ d: string; a: string; p: number }>(
      'select current_database() d, inet_server_addr()::text a, inet_server_port() p');
    console.log(`ALVO MEDIDO CONTRA O SERVIDOR: db=${m.rows[0].d} host=${m.rows[0].a} porta=${m.rows[0].p}`);
    ok('alvo medido é o local',
       m.rows[0].d === LOCAL_DB_NAME && LOCAL_DB_PORTS.includes(String(m.rows[0].p) as (typeof LOCAL_DB_PORTS)[number]),
       `base=${LOCAL_DB_NAME} portas=${LOCAL_DB_PORTS.join('/')}`);

    await cli.query('BEGIN');
    const novo = async () => (await cli.query<{ id: string }>(
      `INSERT INTO patients (first_name, last_name, country, is_test, clinical_specialty)
       VALUES ('Sintetico','FIXTURE-DERIVADO','AR',true,'ASD') RETURNING id`)).rows[0].id;
    const leia = async (id: string) => (await cli.query<{ c: string | null }>(
      'SELECT clinical_specialty c FROM patients WHERE id=$1', [id])).rows[0].c;

    // ── 1. leitura possível, com valor ──────────────────────────────────────
    const p1 = await novo();
    await cli.query(UPDATE, [p1, 'NEUROLOGICAL', true]);
    const v1 = await leia(p1);
    console.log(`\n[1] leitura POSSÍVEL com valor  → antes='ASD'  depois=${JSON.stringify(v1)}`);
    ok('valor novo é gravado', v1 === 'NEUROLOGICAL', 'o caminho normal não regrediu');

    // ── 2. leitura possível e vazia (D-E) ───────────────────────────────────
    const p2 = await novo();
    await cli.query(UPDATE, [p2, null, true]);
    const v2 = await leia(p2);
    console.log(`[2] leitura POSSÍVEL e VAZIA   → antes='ASD'  depois=${JSON.stringify(v2)}`);
    ok('vazio legítimo AINDA apaga (D-E)', v2 === null,
       'congelado pareceria dado atual — a trava não é "nunca escrever"');

    // ── 3. leitura IMPOSSÍVEL — o conserto ──────────────────────────────────
    const p3 = await novo();
    await cli.query(UPDATE, [p3, null, false]);
    const v3 = await leia(p3);
    console.log(`[3] leitura IMPOSSÍVEL         → antes='ASD'  depois=${JSON.stringify(v3)}`);
    ok('ILEGÍVEL não toca na coluna', v3 === 'ASD',
       'o valor anterior sobrevive — sem COALESCE e sem leitura prévia');

    // ── 4. CONTROLE NEGATIVO: o UPDATE ANTIGO, no mesmo caso 3 ──────────────
    const p4 = await novo();
    await cli.query(UPDATE_ANTIGO, [p4, null]);
    const v4 = await leia(p4);
    console.log(`\n[4] CONTROLE NEGATIVO — o UPDATE de ontem, mesmo caso 3 → depois=${JSON.stringify(v4)}`);
    ok('sem a bandeira, o dado É apagado', v4 === null,
       'é a prova de que o defeito era real e de que o conserto é o que mudou o resultado');

    await cli.query('ROLLBACK');
    const sobrou = (await cli.query<{ n: string }>(
      `SELECT count(*) n FROM patients WHERE last_name='FIXTURE-DERIVADO'`)).rows[0].n;
    ok('limpeza', sobrou === '0', `ROLLBACK — sintéticos restantes=${sobrou}`);
  } finally {
    cli.release();
    await pool.end();
  }
  console.log(falhas === 0 ? '\n=== VERIFICAÇÕES: TODAS OK ===' : `\n=== FALHAS: ${falhas} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
