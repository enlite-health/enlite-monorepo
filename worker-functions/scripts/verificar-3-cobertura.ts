/**
 * verificar-3-cobertura.ts — os critérios da Fase 3, provados CONTRA O BANCO.
 *
 * Por que contra o banco e não com `pg` falso: foi um `pg` falso que deixou a suíte verde em
 * 1985/1985 com o registro de recusa quebrado (`42703`) o dia inteiro (D179). Onde a decisão é
 * do SQL — índice único, DELETE+INSERT, lock — o dublê mede a intenção, não a regra.
 *
 * Cinco medições:
 *   1. múltiplo funciona: 2 coberturas entram e saem na ordem
 *   2. o conjunto é SUBSTITUÍDO, não acumulado (é o caminho do sync)
 *   3. ILEGÍVEL não apaga — o critério que vale 345 pacientes (D167)
 *   4. vazio LEGÍTIMO apaga (D-E): congelado pareceria dado atual
 *   5. duplicata é recusada COM MOTIVO, e o banco recusa também
 *
 * ⚠️ Escreve. Só Postgres local em docker, alvo reconferido contra o servidor. ROLLBACK no fim.
 */
import { Pool } from 'pg';
import { assertLocalDatabaseTarget, LOCAL_DB_NAME, LOCAL_DB_PORTS } from '@shared/database/assertLocalDatabaseTarget';
import { classifyInsuranceLabels, PatientInsuranceVerifiedRepository } from '@modules/case';

let falhas = 0;
const ok = (r: string, c: boolean, d: string) => { console.log(`${c ? 'OK  ' : 'FALHA'} | ${r} | ${d}`); if (!c) falhas += 1; };

const OSDE = 'OSDE', SWISS = 'Swiss Medical';

async function main(): Promise<void> {
  console.log(`ALVO DECLARADO (trava passou): ${assertLocalDatabaseTarget(process.env.DATABASE_URL)}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli = await pool.connect();
  try {
    const m = await cli.query<{ d: string; p: number }>('select current_database() d, inet_server_port() p');
    console.log(`ALVO MEDIDO CONTRA O SERVIDOR: db=${m.rows[0].d} porta=${m.rows[0].p}`);
    ok('alvo medido é o local',
       m.rows[0].d === LOCAL_DB_NAME && LOCAL_DB_PORTS.includes(String(m.rows[0].p) as (typeof LOCAL_DB_PORTS)[number]),
       `base=${LOCAL_DB_NAME}`);

    await cli.query('BEGIN');
    const pac = async () => (await cli.query<{ id: string }>(
      `INSERT INTO patients (first_name,last_name,country,is_test) VALUES ('Sintetico','FIXTURE-COB','AR',true) RETURNING id`)).rows[0].id;
    const grava = async (id: string, labels: string[]) => {
      await cli.query('DELETE FROM patient_insurance_verified WHERE patient_id=$1', [id]);
      for (let i = 0; i < labels.length; i++)
        await cli.query(`INSERT INTO patient_insurance_verified (patient_id,ordinal,raw_label,source) VALUES ($1,$2,$3,'clickup')`,
                        [id, i + 1, labels[i]]);
    };
    const le = async (id: string) => (await cli.query<{ raw_label: string; ordinal: number }>(
      'SELECT ordinal, raw_label FROM patient_insurance_verified WHERE patient_id=$1 ORDER BY ordinal', [id])).rows;

    // ── 1. múltiplo ────────────────────────────────────────────────────────
    const p1 = await pac();
    await grava(p1, [OSDE, SWISS]);
    const r1 = await le(p1);
    console.log(`\n[1] duas coberturas → ${JSON.stringify(r1.map(x => `${x.ordinal}:${x.raw_label}`))}`);
    ok('múltiplo funciona, na ordem', r1.length === 2 && r1[0].raw_label === OSDE && r1[1].raw_label === SWISS,
       'é o que a coluna escalar não conseguia guardar');

    // ── 2. SUBSTITUI, não acumula ──────────────────────────────────────────
    await grava(p1, [SWISS]);
    const r2 = await le(p1);
    console.log(`[2] re-sync com UMA cobertura → ${JSON.stringify(r2.map(x => x.raw_label))}`);
    ok('o conjunto é substituído', r2.length === 1 && r2[0].raw_label === SWISS,
       'acumular faria a cobertura antiga sobreviver a uma troca de obra social');

    // ── 3. ILEGÍVEL não apaga ──────────────────────────────────────────────
    // ⚠️ Chama o REPOSITÓRIO REAL, não uma simulação. A 1ª versão deste bloco escrevia
    // `if (ilegivel.readable) await grava(...)` — isso testa o `if` do próprio script, não
    // o código que vai para produção. Medido: arrancar a trava do repositório deixava este
    // bloco VERDE. Oráculo que não toca o código não prova nada sobre o código.
    const repo = new PatientInsuranceVerifiedRepository();
    const antes = (await le(p1)).length;
    const res3 = await repo.replaceForPatient(
      { patientId: p1, read: { readable: false, reason: 'options_unresolved' } }, cli);
    const r3 = await le(p1);
    console.log(`[3] leitura ILEGÍVEL pelo repositório REAL → outcome=${res3.outcome} | antes=${antes} depois=${r3.length}`);
    ok('ilegível NÃO apaga (D167)', r3.length === antes && antes > 0 && res3.outcome === 'skipped-unreadable',
       'é o que vale 345 pacientes no dia em que o campo for renomeado no ClickUp');

    // ── 3b. CONTROLE POSITIVO: o MESMO repositório, com leitura possível, ESCREVE ───
    const res3b = await repo.replaceForPatient(
      { patientId: p1, read: { readable: true, labels: [OSDE] } }, cli);
    const r3b = await le(p1);
    console.log(`[3b] leitura POSSÍVEL pelo mesmo repositório → outcome=${res3b.outcome} | ${r3b.length} linha(s)`);
    ok('e o repositório NÃO é "nunca escrever"', res3b.outcome === 'written' && r3b.length === 1,
       'sem este controle, uma trava chumbada em `skipped-unreadable` passaria no bloco 3');

    // ── 4. vazio LEGÍTIMO apaga ────────────────────────────────────────────
    const res4 = await repo.replaceForPatient({ patientId: p1, read: { readable: true, labels: [] } }, cli);
    const r4 = await le(p1);
    console.log(`     (pelo repositório real: outcome=${res4.outcome})`);
    console.log(`[4] vazio LEGÍTIMO → ${r4.length} linha(s)`);
    ok('vazio legítimo APAGA (D-E)', r4.length === 0,
       'a trava não é "nunca apagar": congelado pareceria dado atual');

    // ── 5. duplicata: recusada no código E no banco ─────────────────────────
    const c = classifyInsuranceLabels([OSDE, OSDE, '   ', SWISS]);
    console.log(`\n[5] classify([OSDE, OSDE, '   ', Swiss]) → aceitos=${JSON.stringify(c.accepted)} recusados=${JSON.stringify(c.rejected.map(x => x.reason))}`);
    ok('duplicata e branco recusados COM motivo', c.accepted.length === 2 && c.rejected.length === 2,
       'recusar em silêncio faria a contagem não bater e ninguém saber por quê');

    const p2 = await pac();
    await cli.query(`INSERT INTO patient_insurance_verified (patient_id,ordinal,raw_label,source) VALUES ($1,1,$2,'clickup')`, [p2, OSDE]);
    await cli.query('SAVEPOINT t');
    let sqlstate: string | null = null;
    try {
      await cli.query(`INSERT INTO patient_insurance_verified (patient_id,ordinal,raw_label,source) VALUES ($1,2,$2,'clickup')`, [p2, OSDE]);
      await cli.query('RELEASE SAVEPOINT t');
    } catch (e) { await cli.query('ROLLBACK TO SAVEPOINT t'); sqlstate = (e as { code?: string }).code ?? null; }
    console.log(`[5b] mesma cobertura em posição diferente → ${sqlstate ?? 'ACEITOU (não recusou!)'}`);
    ok('o BANCO também recusa a duplicata', sqlstate === '23505',
       'índice único uq_patient_insurance_verified_value — a régua não depende do código');

    await cli.query('ROLLBACK');
    const sobrou = (await cli.query<{ n: string }>(`SELECT count(*) n FROM patients WHERE last_name='FIXTURE-COB'`)).rows[0].n;
    ok('limpeza', sobrou === '0', `ROLLBACK — sintéticos restantes=${sobrou}`);
  } finally { cli.release(); await pool.end(); }
  console.log(falhas === 0 ? '\n=== VERIFICAÇÕES: TODAS OK ===' : `\n=== FALHAS: ${falhas} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
