/**
 * verificar-2.7-crus-diferentes.ts — o critério 2.7 da Fase 2 de `campos-admissao`.
 *
 * A afirmação a provar: dois pacientes classificados em `AT para …` e `Cuidado Integral …`
 * do MESMO eixo têm crus DIFERENTES — e é o que hoje não acontece (F32).
 *
 * O ponto NÃO é que o derivado colapsa: ele colapsa DE PROPÓSITO, e a D-B manda que continue
 * colapsando. O defeito é o cru nunca ter sido guardado. Então esta prova tem DUAS metades, e
 * a primeira é o controle: o derivado dos dois é IGUAL (senão a fase estaria consertando a
 * coisa errada) e o cru dos dois é DIFERENTE (que é o conserto).
 *
 * ⚠️ Escreve. Usa a mesma trava de alvo do `verificar-2.2-teto-no-banco.ts`: só Postgres local
 * em docker, e o alvo é reconferido CONTRA O SERVIDOR depois de conectar. Tudo é sintético
 * (`is_test=true`), criado e apagado numa transação que termina em ROLLBACK.
 *
 * Uso: DATABASE_URL=postgresql://...localhost:5432/enlite_e2e \
 *        npx ts-node -r tsconfig-paths/register scripts/verificar-2.7-crus-diferentes.ts
 */

import { Pool } from 'pg';
import { assertLocalDatabaseTarget, LOCAL_DB_NAME, LOCAL_DB_PORTS } from '@shared/database/assertLocalDatabaseTarget';
import { mapClickUpClinicalSpecialty } from '../src/modules/integration/infrastructure/clickup/mappings/clinicalSpecialtyMap';

const CAMPO = 'Segmentos Clínicos';
const EIXO_AT   = 'AT para Pacientes con TEA';
const EIXO_CUID = 'Cuidado Integral de Pacientes con TEA';

let falhas = 0;
const ok = (rotulo: string, cond: boolean, detalhe: string) => {
  console.log(`${cond ? 'OK  ' : 'FALHA'} | ${rotulo} | ${detalhe}`);
  if (!cond) falhas += 1;
};

async function main(): Promise<void> {
  const alvo = assertLocalDatabaseTarget(process.env.DATABASE_URL);
  console.log(`ALVO DECLARADO (trava passou): ${alvo}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli  = await pool.connect();
  try {
    const m = await cli.query<{ d: string; a: string; p: number }>(
      'select current_database() d, inet_server_addr()::text a, inet_server_port() p');
    console.log(`ALVO MEDIDO CONTRA O SERVIDOR: db=${m.rows[0].d} host=${m.rows[0].a} porta=${m.rows[0].p}`);
    const portaMedida = String(m.rows[0].p) as (typeof LOCAL_DB_PORTS)[number];
    ok('alvo medido é o local', m.rows[0].d === LOCAL_DB_NAME && LOCAL_DB_PORTS.includes(portaMedida),
       `base=${LOCAL_DB_NAME} portas permitidas=${LOCAL_DB_PORTS.join('/')}`);

    await cli.query('BEGIN');

    // ── metade 1: o DERIVADO colapsa (é o F32, e é o comportamento CORRETO da D-B) ──
    const derA = mapClickUpClinicalSpecialty(EIXO_AT);
    const derB = mapClickUpClinicalSpecialty(EIXO_CUID);
    console.log(`\n[1] derivado dos dois rótulos do MESMO eixo`);
    console.log(`      mapClickUpClinicalSpecialty(${JSON.stringify(EIXO_AT)})   = ${JSON.stringify(derA)}`);
    console.log(`      mapClickUpClinicalSpecialty(${JSON.stringify(EIXO_CUID)}) = ${JSON.stringify(derB)}`);
    ok('o derivado COLAPSA os dois (F32)', derA !== null && derA === derB,
       `os dois viram ${JSON.stringify(derA)} — é o colapso proposital que a D-B mantém`);

    // ── dois pacientes sintéticos, um em cada rótulo ────────────────────────────
    const cria = async (sufixo: string, rotulo: string, derivado: string | null) => {
      const r = await cli.query<{ id: string }>(
        `INSERT INTO patients (first_name, last_name, country, is_test, clinical_specialty)
         VALUES ($1, 'FIXTURE-2.7', 'AR', true, $2) RETURNING id`, [`Sintetico-${sufixo}`, derivado]);
      const id = r.rows[0].id;
      await cli.query(
        `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label, source)
         VALUES ($1, $2, 1, $3, 'clickup')`, [id, CAMPO, rotulo]);
      return id;
    };
    const pA = await cria('A', EIXO_AT,   derA);
    const pB = await cria('B', EIXO_CUID, derB);

    // ── metade 2: o CRU distingue ──────────────────────────────────────────────
    const lido = await cli.query<{ id: string; clinical_specialty: string | null; raw_label: string }>(
      `SELECT p.id, p.clinical_specialty, l.raw_label
         FROM patients p JOIN patient_source_labels l ON l.patient_id = p.id
        WHERE p.id = ANY($1) AND l.field_name = $2
        ORDER BY p.first_name`, [[pA, pB], CAMPO]);

    console.log(`\n[2] os dois pacientes, lado a lado`);
    for (const r of lido.rows) {
      console.log(`      derivado=${JSON.stringify(r.clinical_specialty)}  cru=${JSON.stringify(r.raw_label)}`);
    }

    ok('leu os dois', lido.rows.length === 2, `${lido.rows.length} linha(s) — contagem zero ou parcial reprova (F19/M46)`);
    const derivados = new Set(lido.rows.map(r => r.clinical_specialty));
    const crus      = new Set(lido.rows.map(r => r.raw_label));
    ok('derivado IGUAL nos dois', derivados.size === 1, `${derivados.size} valor(es) distinto(s): ${JSON.stringify([...derivados])}`);
    ok('cru DIFERENTE nos dois', crus.size === 2, `${crus.size} valor(es) distinto(s) — a distinção que a F32 dizia sumir`);

    // ── CONTROLE NEGATIVO: sem o cru, os dois são indistinguíveis ──────────────
    const soDerivado = new Set(lido.rows.map(r => JSON.stringify(r.clinical_specialty)));
    console.log(`\n[3] CONTROLE NEGATIVO — olhando SÓ o derivado, quantos pacientes distintos se vê?`);
    console.log(`      distintos por derivado = ${soDerivado.size} (de 2 pacientes)`);
    ok('sem o cru eles seriam indistinguíveis', soDerivado.size === 1,
       'é exatamente a perda que a Fase 2 fecha — a régua morde dos dois lados');

    await cli.query('ROLLBACK');
    const sobrou = await cli.query<{ n: string }>(
      `SELECT count(*) n FROM patients WHERE last_name = 'FIXTURE-2.7'`);
    ok('limpeza', sobrou.rows[0].n === '0', `ROLLBACK — paciente sintético restante=${sobrou.rows[0].n}`);
  } finally {
    cli.release();
    await pool.end();
  }

  console.log(falhas === 0 ? '\n=== VERIFICAÇÕES: TODAS OK ===' : `\n=== FALHAS: ${falhas} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
