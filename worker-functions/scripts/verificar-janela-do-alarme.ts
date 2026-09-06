/**
 * verificar-janela-do-alarme.ts — mata o mutante M8, que sobreviveu ao QA-caça da rodada 3.
 *
 * O QA rodou 21 mutantes; 20 morreram. Sobreviveu justamente este: trocar
 * `REJECTION_WARN_WINDOW` de `'24 hours'` para `'100 years'` deixa `npm test` VERDE — e uma
 * janela de 100 anos é o defeito 4 da rodada 2 de volta (o alarme que toca uma vez na vida do
 * registro e cala para sempre). O único teste da janela fabricava `warn_now` num `pg` falso:
 * mediu a intenção do TypeScript, não a decisão do SQL.
 *
 * A janela é decidida INTEIRAMENTE dentro do `ON CONFLICT DO UPDATE`, comparando
 * `last_warned_at` com `NOW() - $8::interval`. Nenhum dublê exercita isso. Só o servidor.
 *
 * Três medições, no mesmo rótulo recusado:
 *   1. 1ª recusa                      → grita (é nova)
 *   2. 2ª recusa DENTRO da janela     → NÃO grita (dedupe)
 *   3. 3ª recusa com a janela VENCIDA → grita de novo  ← o que o M8 matava
 *
 * ⚠️ CADA recusa roda em TRANSAÇÃO PRÓPRIA, e isso não é detalhe: no Postgres `NOW()` é o
 * instante de INÍCIO DA TRANSAÇÃO, não do comando. Numa bancada de transação única o relógio
 * congela, `last_warned_at >= NOW()` é sempre verdadeiro e o dedupe NUNCA aparece — a 1ª versão
 * deste script mediu exatamente isso e acusou um defeito que era do instrumento. É o mesmo
 * formato de erro que o `pg` falso cometia: um ambiente que não reproduz a condição medida.
 * Em produção cada webhook é a sua própria transação, e é isso que se reproduz aqui.
 *
 * ⚠️ Escreve. Só Postgres local em docker, alvo reconferido contra o servidor. Limpeza
 * explícita por `DELETE` no `finally` — sem transação envolvente, não há ROLLBACK que sirva.
 */
import { Pool } from 'pg';
import { assertLocalDatabaseTarget, LOCAL_DB_NAME, LOCAL_DB_PORTS } from '@shared/database/assertLocalDatabaseTarget';

let falhas = 0;
const ok = (r: string, c: boolean, d: string) => { console.log(`${c ? 'OK  ' : 'FALHA'} | ${r} | ${d}`); if (!c) falhas += 1; };

const CAMPO = 'Segmentos Clínicos';
const ROTULO = 'Segmento Personalizado';

/** O `ON CONFLICT` real do repositório, com a janela como parâmetro para poder ser SABOTADA. */
const SQL = `INSERT INTO patient_source_label_rejections
   (patient_id, field_name, raw_label, reason, ceiling, received, source)
 VALUES ($1,$2,$3,'ceiling',3,4,'clickup')
 ON CONFLICT (patient_id, field_name, raw_label, reason) DO UPDATE
   SET occurrences = patient_source_label_rejections.occurrences + 1,
       rejected_at = NOW(),
       last_warned_at = CASE
         WHEN patient_source_label_rejections.last_warned_at <= NOW() - $4::interval
           THEN NOW()
         ELSE patient_source_label_rejections.last_warned_at
       END
 RETURNING occurrences, (last_warned_at >= NOW()) AS warn_now`;

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

    const paciente = async () => (await cli.query<{ id: string }>(
      `INSERT INTO patients (first_name,last_name,country,is_test)
       VALUES ('Sintetico','FIXTURE-JANELA','AR',true) RETURNING id`)).rows[0].id;
    const recusa = async (id: string, janela: string) =>
      (await cli.query<{ occurrences: number; warn_now: boolean }>(SQL, [id, CAMPO, ROTULO, janela])).rows[0];
    /** Envelhece o registro para além da janela, sem esperar 24h de relógio. */
    const envelhece = async (id: string, quanto: string) =>
      cli.query(`UPDATE patient_source_label_rejections SET last_warned_at = NOW() - $2::interval
                 WHERE patient_id=$1`, [id, quanto]);

    // ── a janela REAL: 24 horas ─────────────────────────────────────────────
    const p1 = await paciente();
    const r1 = await recusa(p1, '24 hours');
    const r2 = await recusa(p1, '24 hours');
    await envelhece(p1, '25 hours');
    const r3 = await recusa(p1, '24 hours');
    console.log(`\n[janela REAL = 24 hours]`);
    console.log(`   1ª recusa               → occurrences=${r1.occurrences} grita=${r1.warn_now}`);
    console.log(`   2ª DENTRO da janela     → occurrences=${r2.occurrences} grita=${r2.warn_now}`);
    console.log(`   3ª com a janela VENCIDA → occurrences=${r3.occurrences} grita=${r3.warn_now}`);
    ok('1ª recusa grita', r1.warn_now === true, 'recusa nova sempre acende');
    ok('2ª dentro da janela NÃO grita', r2.warn_now === false, 'é o dedupe do defeito 8');
    ok('3ª com a janela vencida GRITA de novo', r3.warn_now === true,
       '<<< é exatamente esta linha que o mutante M8 apagava');
    ok('o contador nunca para', r3.occurrences === 3, `occurrences=${r3.occurrences} — dedupe é do AVISO, não da contagem`);

    // ── CONTROLE POSITIVO: o mutante M8, exercitado ─────────────────────────
    const p2 = await paciente();
    await recusa(p2, '100 years');
    await recusa(p2, '100 years');
    await envelhece(p2, '25 hours');
    const s3 = await recusa(p2, '100 years');
    console.log(`\n[CONTROLE POSITIVO — a janela SABOTADA para 100 years (o mutante M8)]`);
    console.log(`   3ª com 25h de idade     → occurrences=${s3.occurrences} grita=${s3.warn_now}`);
    ok('com 100 years o alarme NÃO re-acende', s3.warn_now === false,
       'a régua morde: a sabotagem produz resultado DIFERENTE, então o teste acima mede mesmo');

  } finally {
    // Limpeza explícita: cada recusa teve transação própria, então não há ROLLBACK que as
    // desfaça. Roda no `finally` para que uma falha no meio não deixe resíduo sintético.
    const del = await cli.query(`DELETE FROM patients WHERE last_name='FIXTURE-JANELA'`);
    const sobrou = (await cli.query<{ n: string }>(`SELECT count(*) n FROM patients WHERE last_name='FIXTURE-JANELA'`)).rows[0].n;
    ok('limpeza', sobrou === '0', `${del.rowCount} paciente(s) apagado(s) por DELETE (CASCADE leva as recusas) — restantes=${sobrou}`);
    cli.release(); await pool.end();
  }
  console.log(falhas === 0 ? '\n=== VERIFICAÇÕES: TODAS OK ===' : `\n=== FALHAS: ${falhas} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
