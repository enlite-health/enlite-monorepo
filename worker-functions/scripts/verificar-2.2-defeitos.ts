/**
 * verificar-2.2-defeitos.ts — a prova, CONTRA UM POSTGRES DE VERDADE, dos quatro defeitos do
 * QA-caça da task 2.2 que só o banco consegue demonstrar.
 *
 * A suíte (`tests/unit/__tests__/clickup-2.2-segmento-cru.test.ts`) mede o COMPORTAMENTO do
 * repositório com um duplo do `pg`: quais comandos saem, por qual conexão, em que ordem. O que
 * ela NÃO consegue medir é o que só existe num servidor: um `ROLLBACK` de verdade levando (ou
 * não) uma linha embora, e duas transações SIMULTÂNEAS disputando a mesma chave. É por isso
 * que este script existe — e é a mesma montagem com que o QA mediu os defeitos.
 *
 *   DEFEITO 2  lista vazia por ILEGIBILIDADE apagava os 3 rótulos gravados.
 *   DEFEITO 3  o registro durável da recusa sumia no `ROLLBACK` do chamador.
 *   DEFEITO 4  dois re-syncs concorrentes colidiam em `23505 patient_source_labels_pkey`.
 *   DEFEITO 8  cada re-sync acrescentava outra linha de recusa idêntica, e outro aviso.
 *
 * Cada um vem com CONTROLE POSITIVO — contagem zero sem controle é falha, não sucesso (F19).
 *
 * ⚠️ TRAVA DE ALVO. Este script ESCREVE. Ele se recusa a rodar contra qualquer coisa que não
 * seja o Postgres local em docker: só `localhost`/`127.0.0.1`, só as portas 5432/5433, só a
 * base `enlite_e2e`, e nunca por socket `/cloudsql/`. As portas 5434 (stg) e 5436 (PRD) do
 * `cloud-sql-proxy` estão explicitamente barradas. A trava roda ANTES de qualquer conexão e é
 * reconferida CONTRA O SERVIDOR depois de conectar — um alvo se declara, o outro se mede.
 *
 * ⚠️ TUDO É SINTÉTICO. O paciente criado aqui tem `is_test = true`, nome literal `FIXTURE`, e é
 * APAGADO no fim (com a contagem de resíduo impressa). Nenhuma ficha real é lida. Nenhum
 * identificador de paciente sai em stdout — o uuid do sintético é o único id impresso, e ele é
 * criado e destruído por este script.
 *
 * Uso: DATABASE_URL=postgresql://...localhost:5432/enlite_e2e \
 *        npx ts-node -r tsconfig-paths/register scripts/verificar-2.2-defeitos.ts
 */

import { PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  PatientSourceLabelRepository,
  PatientSourceLabelCeilingError,
  sourceLabelsRead,
  sourceLabelsUnreadable,
} from '@modules/case';
import { assertLocalDatabaseTarget, LOCAL_DB_NAME, LOCAL_DB_PORTS } from '@shared/database/assertLocalDatabaseTarget';

const CAMPO = 'Segmentos Clínicos';
const S1 = 'AT para Pacientes con TEA';
const S2 = 'Cuidado Integral de Pacientes con TEA';
const S3 = 'AT para Pacientes con Enfermedades Neurológicas';
const S4 = 'SINTETICO-SEGMENTO-QUARTO';

let falhas = 0;
function ok(rotulo: string, condicao: boolean, detalhe: string): void {
  console.log(`${condicao ? 'OK  ' : 'FALHA'} | ${rotulo} | ${detalhe}`);
  if (!condicao) falhas += 1;
}

/** Conta avisos emitidos enquanto `fn` roda, sem escondê-los da saída. */
async function contandoAvisos<T>(fn: () => Promise<T>): Promise<{ out: T; avisos: string[] }> {
  const avisos: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    avisos.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    const out = await fn();
    return { out, avisos };
  } finally {
    console.warn = original;
  }
}

async function main(): Promise<void> {
  const alvoDeclarado = assertLocalDatabaseTarget(process.env.DATABASE_URL);
  console.log(`ALVO DECLARADO (trava passou): ${alvoDeclarado}`);

  const db = DatabaseConnection.getInstance();
  const pool = db.getPool();

  const alvo = await pool.query<{ db: string; porta: number; host: string | null }>(
    'SELECT current_database() AS db, inet_server_port() AS porta, host(inet_server_addr()) AS host',
  );
  const a = alvo.rows[0];
  console.log(`ALVO MEDIDO NO SERVIDOR: current_database=${a.db} inet_server_port=${a.porta} inet_server_addr=${a.host}`);
  if (a.db !== LOCAL_DB_NAME || !(LOCAL_DB_PORTS as readonly string[]).includes(String(a.porta))) {
    throw new Error('TRAVA (pós-conexão): o servidor não é o local. Abortado sem escrever nada.');
  }

  const repo = new PatientSourceLabelRepository();

  // Paciente sintético COMMITADO: o defeito 3 exige que o registro durável saia por OUTRA
  // conexão, e outra conexão só enxerga um paciente já commitado.
  const criado = await pool.query<{ id: string }>(
    `INSERT INTO patients (first_name, last_name, is_test, origin)
     VALUES ('FIXTURE', 'TASK-2.2-DEFEITOS', true, 'admin_manual') RETURNING id`,
  );
  const pid = criado.rows[0].id;
  console.log(`\n[paciente sintético criado — is_test=true, apagado no fim]`);

  const rotulos = async (): Promise<string[]> => {
    const r = await pool.query<{ raw_label: string }>(
      `SELECT raw_label FROM patient_source_labels WHERE patient_id=$1 AND field_name=$2 ORDER BY ordinal`,
      [pid, CAMPO],
    );
    return r.rows.map(x => x.raw_label);
  };
  const recusas = async (): Promise<Array<{ raw_label: string; reason: string; occurrences: number }>> => {
    const r = await pool.query<{ raw_label: string; reason: string; occurrences: number }>(
      `SELECT raw_label, reason, occurrences FROM patient_source_label_rejections
        WHERE patient_id=$1 ORDER BY raw_label`,
      [pid],
    );
    return r.rows;
  };

  try {
    // ══ DEFEITO 2 ═════════════════════════════════════════════════════════════
    console.log(`\n── DEFEITO 2: origem ILEGÍVEL não pode apagar o cru ──────────────────`);
    await repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3]) });
    console.log(`   [1] sync normal (3 rótulos) → ${JSON.stringify(await rotulos())}`);

    const ilegivel = await repo.replaceForField({
      patientId: pid, fieldName: CAMPO, read: sourceLabelsUnreadable('field-not-in-catalog'),
    });
    const depoisDoIlegivel = await rotulos();
    console.log(`   [2] replaceForField(ILEGÍVEL) → outcome=${ilegivel.outcome}`);
    console.log(`       rótulos no banco DEPOIS  = ${JSON.stringify(depoisDoIlegivel)}`);
    ok('defeito 2 — ilegível NÃO apaga',
      depoisDoIlegivel.length === 3 && ilegivel.outcome === 'skipped-unreadable',
      `${depoisDoIlegivel.length} rótulos preservados (o QA mediu 0 aqui)`);

    const vazio = await repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([]) });
    const depoisDoVazio = await rotulos();
    console.log(`   [3] CONTROLE POSITIVO — replaceForField(VAZIO LEGÍTIMO) → outcome=${vazio.outcome}`);
    console.log(`       rótulos no banco DEPOIS  = ${JSON.stringify(depoisDoVazio)}`);
    ok('defeito 2 — vazio legítimo AINDA apaga (D-E)',
      depoisDoVazio.length === 0 && vazio.outcome === 'written',
      'a trava não é "nunca apagar": congelado pareceria dado');

    // ══ DEFEITO 3 ═════════════════════════════════════════════════════════════
    console.log(`\n── DEFEITO 3: o registro durável sobrevive ao ROLLBACK do chamador ───`);
    await repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3]) });
    await pool.query(`DELETE FROM patient_source_label_rejections WHERE patient_id=$1`, [pid]);
    console.log(`   [1] estado: rótulos=${JSON.stringify(await rotulos())} | recusas=${JSON.stringify(await recusas())}`);

    const caller: PoolClient = await db.getClient();
    let erroDoTeto: string | null = null;
    try {
      await caller.query('BEGIN');
      await repo.appendForField({ patientId: pid, fieldName: CAMPO, label: S4 }, caller);
    } catch (e) {
      erroDoTeto = (e as Error).name;
    }
    const antesDoRollback = await recusas();
    console.log(`   [2] appendForField do 4º DENTRO da transação do chamador → lançou ${erroDoTeto}`);
    console.log(`       ANTES do rollback: recusas=${JSON.stringify(antesDoRollback)}`);
    await caller.query('ROLLBACK');
    caller.release();
    const depoisDoRollback = await recusas();
    console.log(`   [3] o chamador fez ROLLBACK (como PatientService.runUpsertTransaction:211)`);
    console.log(`       DEPOIS do rollback: recusas=${JSON.stringify(depoisDoRollback)}`);
    console.log(`       rótulos anteriores: ${JSON.stringify(await rotulos())}`);
    ok('defeito 3 — a recusa SOBREVIVE ao rollback',
      erroDoTeto === 'PatientSourceLabelCeilingError' && depoisDoRollback.length === 1,
      `${depoisDoRollback.length} recusa(s) depois do ROLLBACK (o QA mediu 0 aqui)`);
    ok('defeito 3 — e os 3 anteriores ficam intactos', (await rotulos()).length === 3, '3 rótulos');

    // CONTROLE POSITIVO do instrumento: o `ROLLBACK` do chamador REALMENTE desfaz o que sai
    // pela transação dele. Sem isto, o teste acima passaria mesmo com um rollback que não
    // rola nada para trás — régua que não mede o que diz medir (D157).
    const caller2: PoolClient = await db.getClient();
    await caller2.query('BEGIN');
    await caller2.query(
      `INSERT INTO patient_source_label_rejections (patient_id, field_name, raw_label, reason, ceiling, received)
       VALUES ($1,$2,'SINTETICO-CONTROLE-ROLLBACK','blank',3,1)`, [pid, CAMPO],
    );
    const dentroDaTx = (await caller2.query(
      `SELECT count(*)::int n FROM patient_source_label_rejections WHERE patient_id=$1 AND raw_label='SINTETICO-CONTROLE-ROLLBACK'`, [pid],
    )).rows[0].n;
    await caller2.query('ROLLBACK');
    caller2.release();
    const foraDaTx = (await pool.query(
      `SELECT count(*)::int n FROM patient_source_label_rejections WHERE patient_id=$1 AND raw_label='SINTETICO-CONTROLE-ROLLBACK'`, [pid],
    )).rows[0].n;
    console.log(`   [4] CONTROLE POSITIVO do instrumento — linha gravada NA transação do chamador:`);
    console.log(`       dentro da transação=${dentroDaTx} | depois do ROLLBACK=${foraDaTx}`);
    ok('defeito 3 — o instrumento mede mesmo (o rollback desfaz)',
      dentroDaTx === 1 && foraDaTx === 0,
      'o que sai pela transação do chamador SOME; o registro durável não');

    // ══ DEFEITO 4 ═════════════════════════════════════════════════════════════
    console.log(`\n── DEFEITO 4: dois re-syncs CONCORRENTES do mesmo (paciente, campo) ──`);
    await repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3]) });
    console.log(`   [1] estado inicial: ${JSON.stringify(await rotulos())}`);

    const umSync = () => repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3]) });
    const simultaneos = await Promise.allSettled([umSync(), umSync()]);
    const descreve = (r: PromiseSettledResult<unknown>) =>
      r.status === 'fulfilled' ? 'OK' : `FALHOU ${(r.reason as { code?: string }).code ?? ''} ${(r.reason as Error).message.split('\n')[0]}`;
    console.log(`   [2] dois re-syncs SIMULTÂNEOS, listas IDÊNTICAS:`);
    console.log(`        sync A: ${descreve(simultaneos[0])}`);
    console.log(`        sync B: ${descreve(simultaneos[1])}`);
    const depoisDosSimultaneos = await rotulos();
    console.log(`       linhas no banco depois: ${JSON.stringify(depoisDosSimultaneos)}`);
    ok('defeito 4 — concorrência não colide',
      simultaneos.every(r => r.status === 'fulfilled') && depoisDosSimultaneos.length === 3,
      `os dois passaram e sobraram ${depoisDosSimultaneos.length} rótulos (o QA mediu "sync B: FALHOU 23505")`);

    // Quatro ao mesmo tempo: uma corrida mais larga não pode achar buraco novo.
    const quatro = await Promise.allSettled([umSync(), umSync(), umSync(), umSync()]);
    console.log(`   [3] quatro SIMULTÂNEOS: ${quatro.map(descreve).join(' · ')}`);
    ok('defeito 4 — e com 4 ao mesmo tempo também',
      quatro.every(r => r.status === 'fulfilled') && (await rotulos()).length === 3,
      'nenhuma colisão de PK, conjunto final íntegro');

    console.log(`   [4] CONTROLE POSITIVO — os mesmos dois em SEQUÊNCIA:`);
    await umSync();
    await umSync();
    console.log(`       sequencial: OK / OK → ${JSON.stringify(await rotulos())}`);
    ok('defeito 4 — sequência continua idempotente', (await rotulos()).length === 3, '3 rótulos, iguais');

    // ══ DEFEITO 8 ═════════════════════════════════════════════════════════════
    console.log(`\n── DEFEITO 8: recusa repetida não acumula linha nem afoga o alarme ───`);

    // O dedupe é ESTRUTURAL (D-C: "no banco é controle"), e a prova disso é o catálogo do
    // Postgres — não o arquivo da migration. A régua vive aqui e não na suíte porque a
    // árvore-sombra do guardian não copia `migrations/`, e um teste que lesse o arquivo
    // ficaria vermelho na sombra por ausência do arquivo, nunca por defeito.
    const idx = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'patient_source_label_rejections'
          AND indexname = 'uq_patient_source_label_rejections_value'`,
    );
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'patient_source_label_rejections'
          AND column_name IN ('occurrences', 'first_rejected_at')`,
    );
    console.log(`   estrutura no banco: ${idx.rows[0]?.indexdef ?? '<índice AUSENTE>'}`);
    console.log(`   colunas do contador: ${JSON.stringify(cols.rows.map(c => c.column_name).sort())}`);
    ok('defeito 8 — o índice único existe NO BANCO',
      /\(patient_id, field_name, raw_label, reason\)/.test(idx.rows[0]?.indexdef ?? ''),
      'UNIQUE (patient_id, field_name, raw_label, reason)');
    ok('defeito 8 — e as colunas do contador também', cols.rowCount === 2, 'occurrences + first_rejected_at');
    await pool.query(`DELETE FROM patient_source_label_rejections WHERE patient_id=$1`, [pid]);
    const quatroRotulos = () =>
      repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, S4]) });

    let avisosTotais = 0;
    for (let i = 1; i <= 5; i++) {
      const { avisos } = await contandoAvisos(quatroRotulos);
      avisosTotais += avisos.length;
      const r = await recusas();
      console.log(`   re-sync #${i} (mesma lista de 4): rótulos=${(await rotulos()).length}` +
                  ` linhas de RECUSA=${r.length} occurrences=${JSON.stringify(r.map(x => x.occurrences))}` +
                  ` avisos nesta rodada=${avisos.length}`);
    }
    const finais = await recusas();
    ok('defeito 8 — 5 re-syncs deixam UMA linha de recusa',
      finais.length === 1 && finais[0].occurrences === 5,
      `linhas=${finais.length} occurrences=${finais[0]?.occurrences} (o QA mediu 5 linhas)`);
    ok('defeito 8 — e UM aviso, não cinco',
      avisosTotais === 1,
      `avisos em 5 rodadas=${avisosTotais} (o QA mediu 5)`);

    // CONTROLE POSITIVO: uma recusa DIFERENTE ainda grita, e ainda cria a sua linha.
    const { avisos: avisosNovo } = await contandoAvisos(() =>
      repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, 'SINTETICO-SEGMENTO-OUTRO']) }));
    const comOOutro = await recusas();
    console.log(`   CONTROLE POSITIVO — recusa INÉDITA: linhas=${comOOutro.length} avisos=${avisosNovo.length}`);
    ok('defeito 8 — o alarme não foi desligado, só desduplicado',
      comOOutro.length === 2 && avisosNovo.length === 1,
      'recusa nova ⇒ linha nova + aviso; recusa repetida ⇒ só contador');

    // C1: nada do que foi emitido pode conter rótulo clínico ou id de paciente.
    // ⚠️ A recusa tem de ser INÉDITA, senão o dedupe do defeito 8 silencia o aviso e esta
    // verificação inspecionaria ZERO linhas — que é "não mediu", nunca "passou" (F19).
    const SENTINELA = `SINTETICO-SEGMENTO-SENTINELA-${Date.now()}`;
    const { avisos: paraInspecao } = await contandoAvisos(() =>
      repo.replaceForField({ patientId: pid, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, SENTINELA]) }));
    const vazou = paraInspecao.filter(l => [S1, S2, S3, SENTINELA, pid].some(x => l.includes(x)));
    console.log(`   C1 — avisos inspecionados=${paraInspecao.length} | com rótulo ou paciente=${vazou.length}`);
    paraInspecao.forEach(l => console.log(`       aviso: ${l}`));
    ok('C1 — o inspetor mediu alguma coisa', paraInspecao.length > 0, `${paraInspecao.length} linha(s) capturada(s) — zero seria "não mediu"`);
    ok('C1 — nem rótulo nem paciente na linha de log', vazou.length === 0, 'o registro identificado vive no BANCO');

    // CONTROLE POSITIVO do detector: ele ACUSA quando a sentinela está mesmo na linha.
    const { avisos: comVazamento } = await contandoAvisos(async () => {
      console.warn('[CONTROLE POSITIVO — formato proibido de propósito]', { patientId: pid, rawLabel: SENTINELA });
    });
    const acusadas = comVazamento.filter(l => [SENTINELA, pid].some(x => l.includes(x)));
    console.log(`   C1 — CONTROLE POSITIVO do detector: capturadas=${comVazamento.length} acusadas=${acusadas.length}`);
    ok('C1 — o detector não está cego', acusadas.length === 1, 'ele acusa quando o valor ESTÁ na linha');
  } finally {
    // ── limpeza ──────────────────────────────────────────────────────────────
    await pool.query(`DELETE FROM patients WHERE id = $1`, [pid]);
    const resto = await pool.query<{ p: number; l: number; r: number }>(
      `SELECT (SELECT count(*)::int FROM patients WHERE id=$1) AS p,
              (SELECT count(*)::int FROM patient_source_labels WHERE patient_id=$1) AS l,
              (SELECT count(*)::int FROM patient_source_label_rejections WHERE patient_id=$1) AS r`,
      [pid],
    );
    console.log(`\n[limpeza] sintético removido — resíduo: ${JSON.stringify(resto.rows[0])}`);
    ok('limpeza', resto.rows[0].p === 0 && resto.rows[0].l === 0 && resto.rows[0].r === 0, 'nada sintético ficou no banco');
    await db.close();
  }

  console.log(`\n=== VERIFICAÇÕES: ${falhas === 0 ? 'TODAS OK' : falhas + ' FALHA(S)'} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('ERRO:', (err as Error).message);
    if (err instanceof PatientSourceLabelCeilingError) console.error('(erro de teto vazando fora do bloco esperado)');
    process.exit(1);
  });
}
