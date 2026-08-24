/**
 * verificar-2.4-backfill.ts — prova o MECANISMO do backfill da 2.4 sem tocar em produção.
 *
 * O problema que este script resolve: o banco local é de teste e não tem os 263 pacientes
 * reais, então `backfill-2.4-segmento-cru.ts` contra o local mede `OBTIDO=0` e recusa —
 * corretamente, mas sem exercitar nada. Rodar contra produção para "ver funcionar" é
 * exatamente o que não se faz.
 *
 * ⇒ Aqui se criam pacientes SINTÉTICOS cujo `clickup_task_id` aponta para tarefas REAIS que
 * têm segmento preenchido. O backfill então tem o que fazer, e o que ele faz é medido.
 *
 * ⚠️ C4: nenhum identificador de tarefa/paciente sai em stdout. Os ids vivem em memória e
 * morrem com o processo. O que se imprime é CONTAGEM.
 *
 * ⚠️ Escreve. Só Postgres local em docker. Limpeza explícita no `finally`.
 */
import { Pool } from 'pg';
import { assertLocalDatabaseTarget } from '@shared/database/assertLocalDatabaseTarget';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { resolveCatalogValue } from '../src/modules/integration/infrastructure/clickup/helpers/resolveCatalogValue';

const LIST_ID = '901304883903';
const CAMPO   = 'Segmentos Clínicos';
const QUANTOS = 3;

let falhas = 0;
const ok = (r: string, c: boolean, d: string) => { console.log(`${c ? 'OK  ' : 'FALHA'} | ${r} | ${d}`); if (!c) falhas += 1; };

async function main(): Promise<void> {
  console.log(`ALVO DECLARADO (trava passou): ${assertLocalDatabaseTarget(process.env.DATABASE_URL)}`);
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN ausente');

  // ── colhe QUANTOS tarefas reais COM segmento legível (ids só em memória) ───
  const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token });
  const alvos: Array<{ taskId: string; labels: string[] }> = [];
  const q = new URLSearchParams({ page: '0', archived: 'false', include_closed: 'false', subtasks: 'false' });
  const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?${q}`, { headers: { Authorization: token } });
  const d = await res.json() as { tasks: Array<{ id: string; custom_fields: Array<{ name: string; value?: unknown }> }> };
  for (const t of d.tasks) {
    if (alvos.length >= QUANTOS) break;
    const cf = Object.fromEntries(t.custom_fields.map(f => [f.name, f.value]));
    const l = resolveCatalogValue(resolver, CAMPO, cf[CAMPO], { warn: false });
    if (l.readable && l.labels.length > 0) alvos.push({ taskId: t.id, labels: l.labels });
  }
  console.log(`\ntarefas reais com segmento legível colhidas: ${alvos.length} (ids retidos — C4)`);
  ok('colheu o que precisava', alvos.length === QUANTOS, `${alvos.length} de ${QUANTOS} — zero seria "não mediu" (F19)`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli  = await pool.connect();
  try {
    // ── pacientes sintéticos apontando para essas tarefas ────────────────────
    for (const a of alvos) {
      await cli.query(
        `INSERT INTO patients (first_name,last_name,country,is_test,clickup_task_id)
         VALUES ('Sintetico','FIXTURE-BACKFILL','AR',true,$1)`, [a.taskId]);
    }
    const conta = async () => Number((await cli.query(
      `SELECT count(*) n FROM patient_source_labels l
         JOIN patients p ON p.id = l.patient_id
        WHERE p.last_name='FIXTURE-BACKFILL' AND l.source='backfill-2.4'`)).rows[0].n);

    console.log(`\n[1] ANTES do backfill: ${await conta()} rótulo(s) cru(s) nos sintéticos`);
    ok('começa vazio', (await conta()) === 0, 'senão o "depois" não prova nada');

    // ── roda o backfill de verdade, em processo separado ─────────────────────
    const { execFileSync } = await import('child_process');
    const saida = execFileSync('npx', ['ts-node','-r','tsconfig-paths/register',
      'scripts/backfill-2.4-segmento-cru.ts','--executar','--esperado',String(QUANTOS)],
      { encoding: 'utf-8', env: process.env });
    const linhaObtido = saida.split('\n').find(l => l.startsWith('OBTIDO:')) ?? '(sem linha OBTIDO)';
    const linhaGrav   = saida.split('\n').find(l => l.startsWith('GRAVADOS:')) ?? '(sem linha GRAVADOS)';
    console.log(`\n[2] o backfill disse: ${linhaObtido.trim()} | ${linhaGrav.trim()}`);

    const depois = await conta();
    const esperadosTotal = alvos.reduce((n, a) => n + Math.min(a.labels.length, 3), 0);
    console.log(`[3] DEPOIS do backfill: ${depois} rótulo(s) cru(s) — esperado ${esperadosTotal}`);
    ok('o backfill gravou o que a origem declara', depois === esperadosTotal,
       `${depois} de ${esperadosTotal} (soma dos rótulos das ${QUANTOS} tarefas, com teto 3)`);
    ok('e a contagem NÃO é zero', depois > 0, 'contagem zero seria falha, não sucesso (F19)');

    // ── IDEMPOTÊNCIA: rodar de novo não duplica ──────────────────────────────
    try {
      execFileSync('npx', ['ts-node','-r','tsconfig-paths/register',
        'scripts/backfill-2.4-segmento-cru.ts','--executar','--esperado',String(QUANTOS)],
        { encoding: 'utf-8', env: process.env });
    } catch { /* recusa por OBTIDO=0 é o comportamento CERTO na 2ª vez */ }
    const depois2 = await conta();
    console.log(`[4] 2ª corrida (idempotência): ${depois2} rótulo(s) — esperado o MESMO ${depois}`);
    ok('rodar duas vezes não duplica', depois2 === depois, `${depois2} vs ${depois}`);

    // ── o ROLLBACK que o script imprime funciona? ────────────────────────────
    const del = await cli.query(`DELETE FROM patient_source_labels WHERE source='backfill-2.4'`);
    const depois3 = await conta();
    console.log(`\n[5] o ROLLBACK impresso pelo script apagou ${del.rowCount} linha(s) → restam ${depois3}`);
    ok('o rollback documentado funciona', depois3 === 0 && (del.rowCount ?? 0) === esperadosTotal,
       'e apaga exatamente o que o backfill pôs, porque `source` marca a origem');
    const derivado = Number((await cli.query(
      `SELECT count(*) n FROM patients WHERE last_name='FIXTURE-BACKFILL' AND clinical_specialty IS NOT NULL`)).rows[0].n);
    ok('o DERIVADO nunca foi tocado', derivado === 0, '`patients` não é escrita pelo backfill');
  } finally {
    await cli.query(`DELETE FROM patients WHERE last_name='FIXTURE-BACKFILL'`);
    const sobrou = (await cli.query<{ n: string }>(`SELECT count(*) n FROM patients WHERE last_name='FIXTURE-BACKFILL'`)).rows[0].n;
    ok('limpeza', sobrou === '0', `sintéticos restantes=${sobrou}`);
    cli.release(); await pool.end();
  }
  console.log(falhas === 0 ? '\n=== VERIFICAÇÕES: TODAS OK ===' : `\n=== FALHAS: ${falhas} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
