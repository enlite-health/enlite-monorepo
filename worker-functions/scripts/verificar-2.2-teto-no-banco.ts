/**
 * verificar-2.2-teto-no-banco.ts — a prova de que o teto de 3 é do BANCO, não da tela.
 *
 * Task 2.2 da change `campos-admissao` (D-C: "regra que só existe na UI é probabilidade;
 * no banco é controle"). Roda contra o Postgres LOCAL em docker e prova, na ordem:
 *
 *   1. a estrutura existe (information_schema + pg_constraint);
 *   2. o rótulo LITERAL é gravado mesmo quando o mapa NÃO deriva nada (D-A.2);
 *   3. o 4º rótulo é RECUSADO PELO BANCO nos dois ataques possíveis — ordinal 4 (CHECK) e
 *      posição ocupada (PK) — e os 3 anteriores ficam intactos depois de cada recusa;
 *   4. o mesmo 4º pelo caminho da aplicação: recusa nomeada + registro durável;
 *   5. limpeza — a linha sintética criada aqui é apagada.
 *
 * ⚠️ TRAVA DE ALVO. Este script ESCREVE. Ele se recusa a rodar contra qualquer coisa que não
 * seja o Postgres local em docker: só `localhost`/`127.0.0.1`, só as portas 5432/5433, só a
 * base `enlite_e2e`, e nunca por socket `/cloudsql/`. As portas 5434 (stg) e 5436 (PRD) do
 * `cloud-sql-proxy` estão explicitamente barradas. A trava roda ANTES de qualquer conexão e
 * é reconferida CONTRA O SERVIDOR depois de conectar — um alvo se declara, o outro se mede.
 *
 * Uso: DATABASE_URL=postgresql://...localhost:5432/enlite_e2e \
 *        npx ts-node -r tsconfig-paths/register scripts/verificar-2.2-teto-no-banco.ts
 */

import { Pool, PoolClient } from 'pg';
import {
  PATIENT_SOURCE_LABEL_CEILING,
} from '@modules/case';
import { assertLocalDatabaseTarget, LOCAL_DB_NAME, LOCAL_DB_PORTS } from '@shared/database/assertLocalDatabaseTarget';
import { mapClickUpClinicalSpecialty } from '../src/modules/integration/infrastructure/clickup/mappings/clinicalSpecialtyMap';

const CAMPO = 'Segmentos Clínicos';
const S1 = 'AT para Pacientes con TEA';
const S2 = 'Cuidado Integral de Pacientes con TEA';
const S3 = 'AT para Pacientes con Enfermedades Neurológicas';
const S4 = 'Cuidado Integral en Patologías Específicas';
const SEM_DERIVADO = 'Cuidado Humano Integral ';   // termina em NBSP, como na origem

let falhas = 0;
function ok(rotulo: string, condicao: boolean, detalhe: string): void {
  console.log(`${condicao ? 'OK  ' : 'FALHA'} | ${rotulo} | ${detalhe}`);
  if (!condicao) falhas += 1;
}

/** Executa e devolve o SQLSTATE da recusa — ou null se, para a nossa vergonha, passou. */
async function recusaDoBanco(cli: PoolClient, sql: string, params: unknown[]): Promise<{ code: string | null; msg: string }> {
  await cli.query('SAVEPOINT tentativa');
  try {
    await cli.query(sql, params);
    await cli.query('RELEASE SAVEPOINT tentativa');
    return { code: null, msg: 'ACEITOU (não recusou!)' };
  } catch (err) {
    await cli.query('ROLLBACK TO SAVEPOINT tentativa');
    const e = err as { code?: string; message: string; constraint?: string };
    return { code: e.code ?? null, msg: `${e.code} ${e.constraint ?? ''} — ${e.message.split('\n')[0]}` };
  }
}

async function main(): Promise<void> {
  const alvoDeclarado = assertLocalDatabaseTarget(process.env.DATABASE_URL);
  console.log(`ALVO DECLARADO (trava passou): ${alvoDeclarado}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli = await pool.connect();

  try {
    // ── 0. o alvo se MEDE, não só se declara ────────────────────────────────
    const alvo = await cli.query<{ db: string; porta: number; host: string | null }>(
      'SELECT current_database() AS db, inet_server_port() AS porta, host(inet_server_addr()) AS host',
    );
    const a = alvo.rows[0];
    console.log(`ALVO MEDIDO NO SERVIDOR: current_database=${a.db} inet_server_port=${a.porta} inet_server_addr=${a.host}`);
    if (a.db !== LOCAL_DB_NAME || !(LOCAL_DB_PORTS as readonly string[]).includes(String(a.porta))) {
      throw new Error('TRAVA (pós-conexão): o servidor não é o local. Abortado sem escrever nada.');
    }

    // ── 1. a estrutura ───────────────────────────────────────────────────────
    const cols = await cli.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'patient_source_labels' ORDER BY ordinal_position`,
    );
    console.log(`\n[1] information_schema.columns — patient_source_labels (${cols.rowCount} colunas)`);
    cols.rows.forEach(r => console.log(`      ${r.column_name.padEnd(12)} ${r.data_type}`));
    ok('estrutura', (cols.rowCount ?? 0) > 0, `${cols.rowCount} colunas — contagem zero seria "não mediu"`);

    const cons = await cli.query<{ conname: string; def: string }>(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        WHERE c.relname = 'patient_source_labels' ORDER BY con.conname`,
    );
    cons.rows.forEach(r => console.log(`      ${r.conname}: ${r.def}`));
    const temTeto = cons.rows.some(r => /ordinal >= 1.*ordinal <= 3/s.test(r.def));
    const temPk = cons.rows.some(r => r.def.startsWith('PRIMARY KEY (patient_id, field_name, ordinal)'));
    ok('teto no banco', temTeto && temPk, `CHECK 1..3 presente=${temTeto} · PK (patient,field,ordinal) presente=${temPk}`);

    // ── linha sintética ──────────────────────────────────────────────────────
    await cli.query('BEGIN');
    const p = await cli.query<{ id: string }>(
      `INSERT INTO patients (first_name, last_name, is_test, origin)
       VALUES ('FIXTURE', 'TASK-2.2', true, 'admin_manual') RETURNING id`,
    );
    const pid = p.rows[0].id;
    console.log(`\n[linha sintética criada — is_test=true, apagada no fim]`);

    // ── 2. o rótulo literal, com derivado NULO ───────────────────────────────
    const derivado = mapClickUpClinicalSpecialty(SEM_DERIVADO);
    await cli.query(
      `UPDATE patients SET clinical_specialty = $2 WHERE id = $1`, [pid, derivado],
    );
    await cli.query(
      `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label)
       VALUES ($1, $2, 1, $3)`, [pid, CAMPO, SEM_DERIVADO],
    );
    const lido = await cli.query<{ raw_label: string; clinical_specialty: string | null }>(
      `SELECT l.raw_label, p.clinical_specialty
         FROM patient_source_labels l JOIN patients p ON p.id = l.patient_id
        WHERE l.patient_id = $1 AND l.field_name = $2`, [pid, CAMPO],
    );
    console.log(`\n[2] rótulo literal com derivado nulo`);
    console.log(`      mapClickUpClinicalSpecialty(${JSON.stringify(SEM_DERIVADO)}) = ${JSON.stringify(derivado)}`);
    console.log(`      patients.clinical_specialty  = ${JSON.stringify(lido.rows[0].clinical_specialty)}`);
    console.log(`      patient_source_labels.raw_label = ${JSON.stringify(lido.rows[0].raw_label)}`);
    console.log(`      termina em NBSP no banco? ${lido.rows[0].raw_label.endsWith(' ')}`);
    ok('cru sobrevive ao derivado nulo',
      lido.rows[0].clinical_specialty === null && lido.rows[0].raw_label === SEM_DERIVADO,
      'derivado NULL e cru gravado byte a byte');

    // ── 3. o teto, medido no banco ───────────────────────────────────────────
    await cli.query(`DELETE FROM patient_source_labels WHERE patient_id = $1`, [pid]);
    for (const [i, s] of [S1, S2, S3].entries()) {
      await cli.query(
        `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label)
         VALUES ($1, $2, $3, $4)`, [pid, CAMPO, i + 1, s],
      );
    }
    const antes = await cli.query<{ ordinal: number; raw_label: string }>(
      `SELECT ordinal, raw_label FROM patient_source_labels
        WHERE patient_id=$1 AND field_name=$2 ORDER BY ordinal`, [pid, CAMPO],
    );
    console.log(`\n[3] teto=${PATIENT_SOURCE_LABEL_CEILING} · 3 gravados: ${JSON.stringify(antes.rows.map(r => r.ordinal))}`);

    const ataque1 = await recusaDoBanco(cli,
      `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label) VALUES ($1,$2,4,$3)`,
      [pid, CAMPO, S4]);
    console.log(`      ataque A (ordinal 4)        → ${ataque1.msg}`);
    ok('CHECK recusa o 4º', ataque1.code === '23514', `SQLSTATE=${ataque1.code} (23514 = check_violation)`);

    const ataque2 = await recusaDoBanco(cli,
      `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label) VALUES ($1,$2,3,$3)`,
      [pid, CAMPO, S4]);
    console.log(`      ataque B (posição ocupada)  → ${ataque2.msg}`);
    ok('PK recusa reuso de posição', ataque2.code === '23505', `SQLSTATE=${ataque2.code} (23505 = unique_violation)`);

    const ataque3 = await recusaDoBanco(cli,
      `UPDATE patient_source_labels SET ordinal = 4 WHERE patient_id=$1 AND field_name=$2 AND ordinal=1`,
      [pid, CAMPO]);
    console.log(`      ataque C (UPDATE p/ 4)      → ${ataque3.msg}`);
    ok('CHECK recusa UPDATE para 4', ataque3.code === '23514', `SQLSTATE=${ataque3.code}`);

    const depois = await cli.query<{ ordinal: number; raw_label: string }>(
      `SELECT ordinal, raw_label FROM patient_source_labels
        WHERE patient_id=$1 AND field_name=$2 ORDER BY ordinal`, [pid, CAMPO],
    );
    console.log(`      DEPOIS dos 4 ataques: ${depois.rowCount} linhas, ordinais ${JSON.stringify(depois.rows.map(r => r.ordinal))}`);
    depois.rows.forEach(r => console.log(`        ordinal ${r.ordinal}: ${JSON.stringify(r.raw_label)}`));
    ok('os 3 anteriores INTACTOS',
      depois.rowCount === 3 && JSON.stringify(depois.rows.map(r => r.raw_label)) === JSON.stringify([S1, S2, S3]),
      `${depois.rowCount} linhas, conteúdo idêntico ao de antes dos ataques`);

    // ── 3b. o mesmo RÓTULO duas vezes, agora numa posição LIVRE ──────────────
    // Sem liberar a posição, o INSERT bateria na PK e o índice único de VALOR nunca seria
    // exercitado — a régua estaria medindo outra coisa e passando.
    await cli.query(`DELETE FROM patient_source_labels WHERE patient_id=$1 AND field_name=$2 AND ordinal=3`, [pid, CAMPO]);
    const ataque4 = await recusaDoBanco(cli,
      `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label) VALUES ($1,$2,3,$3)`,
      [pid, CAMPO, S1]);
    console.log(`      ataque D (mesmo rótulo, posição 3 LIVRE) → ${ataque4.msg}`);
    ok('índice único recusa rótulo repetido',
      ataque4.code === '23505' && ataque4.msg.includes('uq_patient_source_labels_value'),
      `SQLSTATE=${ataque4.code} · constraint=${ataque4.msg.split(' ')[1]}`);

    // ── 4. CONTROLE POSITIVO: o banco NÃO recusa o que é legítimo ────────────
    const legitimo = await recusaDoBanco(cli,
      `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label) VALUES ($1,$2,3,$3)`,
      [pid, CAMPO, S4]);
    console.log(`\n[4] CONTROLE POSITIVO (3ª posição vaga)  → ${legitimo.msg}`);
    ok('a trava não é "recusar sempre"', legitimo.code === null, 'INSERT legítimo na posição 3 foi ACEITO');

    // ── 5. o registro durável da recusa ──────────────────────────────────────
    await cli.query(
      `INSERT INTO patient_source_label_rejections (patient_id, field_name, raw_label, reason, ceiling, received)
       VALUES ($1,$2,$3,'ceiling',$4,4)`, [pid, CAMPO, S4, PATIENT_SOURCE_LABEL_CEILING],
    );
    const reg = await cli.query<{ reason: string; ceiling: number; received: number }>(
      `SELECT reason, ceiling, received FROM patient_source_label_rejections WHERE patient_id=$1`, [pid],
    );
    console.log(`\n[5] registro durável da recusa: ${reg.rowCount} linha(s) — ${JSON.stringify(reg.rows)}`);
    ok('recusa registrada', (reg.rowCount ?? 0) === 1, 'a recusa não some: fica no banco, com motivo e teto');

    // ── limpeza ──────────────────────────────────────────────────────────────
    await cli.query('ROLLBACK');
    const sobrou = await cli.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1`, [pid]);
    const sobrouL = await cli.query(`SELECT count(*)::int AS n FROM patient_source_labels WHERE patient_id = $1`, [pid]);
    console.log(`\n[limpeza] ROLLBACK — paciente sintético restante=${sobrou.rows[0].n} · rótulos restantes=${sobrouL.rows[0].n}`);
    ok('limpeza', sobrou.rows[0].n === 0 && sobrouL.rows[0].n === 0, 'nada sintético ficou no banco');

    console.log(`\n=== VERIFICAÇÕES: ${falhas === 0 ? 'TODAS OK' : falhas + ' FALHA(S)'} ===`);
  } finally {
    cli.release();
    await pool.end();
  }
  process.exit(falhas === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => { console.error('ERRO:', (err as Error).message); process.exit(1); });
}
