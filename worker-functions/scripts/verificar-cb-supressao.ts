/**
 * verificar-cb-supressao.ts — C-B do parecer do `lex` (24/08), provada contra o banco.
 *
 * A prova que o parecer PEDIU, literalmente: "paciente com `deleted_at` preenchido ⇒
 * `SELECT count(*) FROM patient_source_labels WHERE patient_id = $1` = 0".
 *
 * E a metade que o parecer não pediu mas sem a qual a prova não vale: o CONTROLE NEGATIVO —
 * o `UPDATE ... deleted_at` SOZINHO (o caminho de ontem) deixa tudo de pé. É isso que mostra
 * que quem suprime é a chamada nova, e não algum efeito colateral que já existia.
 *
 * ⚠️ Escreve. Só Postgres local em docker, alvo reconferido contra o servidor. ROLLBACK no fim.
 */
import { Pool } from 'pg';
import { assertLocalDatabaseTarget, LOCAL_DB_NAME, LOCAL_DB_PORTS } from '@shared/database/assertLocalDatabaseTarget';
import { PatientSourceLabelRepository, PatientInsuranceVerifiedRepository } from '@modules/case';

let falhas = 0;
const ok = (r: string, c: boolean, d: string) => { console.log(`${c ? 'OK  ' : 'FALHA'} | ${r} | ${d}`); if (!c) falhas += 1; };
const CAMPO = 'Segmentos Clínicos';

async function main(): Promise<void> {
  const alvo = assertLocalDatabaseTarget(process.env.DATABASE_URL);
  console.log(`ALVO DECLARADO (trava passou): ${alvo}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli = await pool.connect();
  try {
    const m = await cli.query<{ d: string; a: string; p: number }>(
      'select current_database() d, inet_server_addr()::text a, inet_server_port() p');
    console.log(`ALVO MEDIDO CONTRA O SERVIDOR: db=${m.rows[0].d} host=${m.rows[0].a} porta=${m.rows[0].p}`);
    ok('alvo medido é o local',
       m.rows[0].d === LOCAL_DB_NAME && LOCAL_DB_PORTS.includes(String(m.rows[0].p) as (typeof LOCAL_DB_PORTS)[number]),
       `base=${LOCAL_DB_NAME}`);

    await cli.query('BEGIN');
    const cria = async () => {
      const id = (await cli.query<{ id: string }>(
        `INSERT INTO patients (first_name,last_name,country,is_test,clinical_specialty)
         VALUES ('Sintetico','FIXTURE-CB','AR',true,'ASD') RETURNING id`)).rows[0].id;
      await cli.query(
        `INSERT INTO patient_source_labels (patient_id,field_name,ordinal,raw_label,source)
         VALUES ($1,$2,1,'AT para Pacientes con TEA','clickup'),($1,$2,2,'Cuidado Integral de Pacientes con TEA','clickup')`,
        [id, CAMPO]);
      await cli.query(
        `INSERT INTO patient_source_label_rejections (patient_id,field_name,raw_label,reason,ceiling,received,source)
         VALUES ($1,$2,'Segmento Personalizado','ceiling',3,4,'clickup')`, [id, CAMPO]);
      // C-B′ (Fase 3): a tabela de cobertura nasceu DEPOIS deste verificador e ficou fora
      // dele. O bloco que "fechou" a C-B não dizia nada sobre ela — a evidência cobria duas
      // tabelas de três. Verificador que não conhece a tabela nova aprova a supressão dela.
      await cli.query(
        `INSERT INTO patient_insurance_verified (patient_id,ordinal,raw_label,source)
         VALUES ($1,1,'OSDE','clickup')`, [id]);
      return id;
    };
    const conta = async (id: string) => ({
      labels:     Number((await cli.query(`SELECT count(*) n FROM patient_source_labels WHERE patient_id=$1`, [id])).rows[0].n),
      rejections: Number((await cli.query(`SELECT count(*) n FROM patient_source_label_rejections WHERE patient_id=$1`, [id])).rows[0].n),
      cobertura:  Number((await cli.query(`SELECT count(*) n FROM patient_insurance_verified WHERE patient_id=$1`, [id])).rows[0].n),
      deleted:    (await cli.query(`SELECT deleted_at FROM patients WHERE id=$1`, [id])).rows[0].deleted_at !== null,
      paciente:   Number((await cli.query(`SELECT count(*) n FROM patients WHERE id=$1`, [id])).rows[0].n),
    });

    // ── CONTROLE NEGATIVO: o soft delete de ONTEM, sozinho ───────────────────
    const pA = await cria();
    await cli.query(`UPDATE patients SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, [pA]);
    const a1 = await conta(pA);
    console.log(`\n[1] CONTROLE NEGATIVO — só o UPDATE deleted_at (o caminho de ontem)`);
    console.log(`      deleted_at preenchido=${a1.deleted}  rótulos=${a1.labels}  recusas=${a1.rejections}`);
    console.log(`      cobertura=${a1.cobertura}`);
    ok('sem a supressão, o clínico literal FICA', a1.deleted && a1.labels === 2 && a1.rejections === 1 && a1.cobertura === 1,
       'é o furo que a C-B nomeou: o CASCADE não dispara no soft delete');

    // ── O CONSERTO: soft delete + purge ─────────────────────────────────────
    const pB = await cria();
    await cli.query(`UPDATE patients SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, [pB]);
    const apagados = await new PatientSourceLabelRepository().purgeForPatient(pB, cli);
    const b1 = await conta(pB);
    console.log(`\n[2] O CONSERTO — soft delete + purgeForPatient()`);
    console.log(`      apagados=${JSON.stringify(apagados)}`);
    console.log(`      deleted_at preenchido=${b1.deleted}  rótulos=${b1.labels}  recusas=${b1.rejections}  paciente ainda existe=${b1.paciente === 1}`);
    ok('o que o lex pediu: rótulos crus = 0', b1.labels === 0, `count=${b1.labels}`);
    ok('e as recusas também', b1.rejections === 0, `count=${b1.rejections}`);
    const cob = await new PatientInsuranceVerifiedRepository().purgeForPatient(pB, cli);
    const b2 = await conta(pB);
    ok('e a COBERTURA também (C-B′)', b2.cobertura === 0 && cob === 1,
       `apagadas=${cob}, restantes=${b2.cobertura} — a 3ª tabela, que o verificador não conhecia`);
    ok('contagem zero aqui é SUCESSO porque havia 2 e 1 antes', apagados.labels === 2 && apagados.rejections === 1,
       'sem esta linha, "0 depois" não distinguiria supressão de nunca ter existido (F19)');
    ok('o PACIENTE permanece (REQ-04 do Marcel)', b1.paciente === 1 && b1.deleted,
       'soft delete preserva rastreabilidade de quem retorna — a supressão é do clínico literal, não do cadastro');

    await cli.query('ROLLBACK');
    const sobrou = (await cli.query<{ n: string }>(`SELECT count(*) n FROM patients WHERE last_name='FIXTURE-CB'`)).rows[0].n;
    ok('limpeza', sobrou === '0', `ROLLBACK — sintéticos restantes=${sobrou}`);
  } finally { cli.release(); await pool.end(); }
  console.log(falhas === 0 ? '\n=== VERIFICAÇÕES: TODAS OK ===' : `\n=== FALHAS: ${falhas} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
