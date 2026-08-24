/**
 * backfill-2.4-segmento-cru.ts — a task 2.4 da Fase 2 de `campos-admissao`.
 *
 * Preenche `patient_source_labels` para os pacientes que JÁ têm segmento clínico classificado
 * no ClickUp e nada do lado de cá. Esperado: **263** (F36, reconferido na 2.1 em 24/08 —
 * 263 com exatamente 1 valor, ZERO com 2+, cobertura 349/349).
 *
 * ── O QUE ESTE SCRIPT NÃO FAZ, e é a parte importante ────────────────────────
 * Ele NÃO inventa o cru a partir do derivado. `patients.clinical_specialty` é o enum canônico
 * de 9 valores; o cru é o rótulo literal de 14-17 opções. Ir de 9 para 17 é adivinhar — e
 * adivinhar aqui grava rótulo clínico ERRADO num paciente real, que é pior que não gravar.
 * A fonte do cru é o ClickUp, e só ele.
 *
 * ⇒ O backfill LÊ a lista do ClickUp (somente `GET`) e grava o rótulo que a origem declara.
 *
 * ── Ordem obrigatória, e o `--dry-run` é o default ───────────────────────────
 *   1. `--dry-run` (default): conta o que FARIA, não escreve nada. Declara esperado × obtido.
 *   2. só com `--executar` escreve, e ainda assim recusa se o obtido divergir do `--esperado`.
 *
 * ── Trava de alvo ────────────────────────────────────────────────────────────
 * ⚠️ Este script escreve em linha de PACIENTE REAL. Contra produção ele só roda com
 * `--eu-sei-que-e-producao`, que é DELIBERADAMENTE desconfortável de digitar, e ainda assim
 * exige `--executar` e `--esperado`. Sem nenhum desses, o alvo permitido é só o local.
 *
 * ── Rollback ─────────────────────────────────────────────────────────────────
 * Impresso no fim de toda corrida, pronto para colar. O backfill só insere em
 * `patient_source_labels` com `source='backfill-2.4'`, então o desfazer é exato:
 *   DELETE FROM patient_source_labels WHERE source = 'backfill-2.4';
 * Nada do derivado é tocado — `patients` não é escrita em momento nenhum.
 */
import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { resolveCatalogValue } from '../src/modules/integration/infrastructure/clickup/helpers/resolveCatalogValue';

const LIST_ID = '901304883903';
const CAMPO   = 'Segmentos Clínicos';
const SOURCE  = 'backfill-2.4';
const API     = 'https://api.clickup.com/api/v2';

const arg = (n: string) => process.argv.includes(n);
const val = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

function travaDeAlvo(url: string | undefined, producaoAutorizada: boolean): string {
  if (!url) throw new Error('DATABASE_URL ausente — sem alvo não há backfill (e ausência não é local)');
  const local = /@(localhost|127\.0\.0\.1):(5432|5433)\/enlite_e2e(\?|$)/.test(url);
  if (local) return 'LOCAL (docker)';
  if (producaoAutorizada) return 'NÃO-LOCAL, autorizado explicitamente';
  throw new Error(
    'ALVO RECUSADO: este script escreve em linha de paciente. Alvo não-local exige ' +
    '--eu-sei-que-e-producao (e --executar e --esperado). Recebido: ' + url.replace(/:[^:@]*@/, ':***@'));
}

async function main(): Promise<void> {
  const executar  = arg('--executar');
  const prod      = arg('--eu-sei-que-e-producao');
  const esperado  = val('--esperado') ? Number(val('--esperado')) : undefined;
  const alvo = travaDeAlvo(process.env.DATABASE_URL, prod);

  console.log(`ALVO: ${alvo}`);
  console.log(`MODO: ${executar ? 'EXECUTAR (escreve)' : 'DRY-RUN (não escreve nada)'}`);
  console.log(`ESPERADO DECLARADO: ${esperado ?? '(não declarado)'}`);
  if (executar && esperado === undefined) throw new Error('--executar exige --esperado: contagem esperada declarada ANTES de rodar (2.4)');

  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN ausente');

  // ── 1. o catálogo e as tarefas vivas, somente GET ──────────────────────────
  const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token });
  const porTarefa = new Map<string, string[]>();
  let pagina = 0, lidas = 0;
  for (;;) {
    const q = new URLSearchParams({ page: String(pagina), archived: 'false', include_closed: 'false', subtasks: 'false' });
    const res = await fetch(`${API}/list/${LIST_ID}/task?${q}`, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`ClickUp /task HTTP ${res.status}`);
    const d = await res.json() as { tasks: Array<{ id: string; custom_fields: Array<{ name: string; value?: unknown }> }>; last_page?: boolean };
    for (const t of d.tasks) {
      lidas++;
      const cf = Object.fromEntries(t.custom_fields.map(f => [f.name, f.value]));
      const leitura = resolveCatalogValue(resolver, CAMPO, cf[CAMPO], { warn: false });
      // ⚠️ ILEGÍVEL não entra no backfill: "não consegui ler" nunca vira dado (D167).
      if (leitura.readable && leitura.labels.length > 0) porTarefa.set(t.id, leitura.labels);
    }
    if (d.last_page || d.tasks.length === 0) break;
    pagina++;
    if (pagina > 200) throw new Error('parei em 200 páginas — leitura PARCIAL, não serve para backfill (M46)');
  }
  console.log(`\nClickUp: ${lidas} tarefa(s) viva(s) lida(s); ${porTarefa.size} com segmento legível`);

  // ── 2. o cruzamento com o nosso banco ──────────────────────────────────────
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli  = await pool.connect();
  try {
    const m = await cli.query<{ d: string }>('select current_database() d');
    console.log(`ALVO MEDIDO CONTRA O SERVIDOR: db=${m.rows[0].d}`);

    const nossos = await cli.query<{ id: string; clickup_task_id: string }>(
      `SELECT p.id, p.clickup_task_id FROM patients p
        WHERE p.clickup_task_id = ANY($1) AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM patient_source_labels l
                           WHERE l.patient_id = p.id AND l.field_name = $2)`,
      [[...porTarefa.keys()], CAMPO]);

    const obtido = nossos.rows.length;
    console.log(`\nOBTIDO: ${obtido} paciente(s) sem cru e com segmento legível na origem`);
    console.log(`ESPERADO: ${esperado ?? '(não declarado)'}   ⇒ ${esperado === undefined ? 'sem comparação' : (obtido === esperado ? 'BATE' : 'DIVERGE')}`);

    if (obtido === 0) { console.log('\nFALHA: zero a preencher — contagem zero é FALHA, nunca sucesso (F19)'); process.exit(1); }
    if (esperado !== undefined && obtido !== esperado) {
      console.log('\nFALHA: obtido ≠ esperado. O backfill NÃO roda com a contagem divergente — a divergência');
      console.log('       é um fato sobre a realidade que precisa ser entendido antes, não um número a atualizar.');
      if (executar) process.exit(1);
    }

    if (!executar) {
      console.log('\nDRY-RUN: nada foi escrito. Para executar: --executar --esperado <n>');
    } else {
      let gravados = 0;
      for (const r of nossos.rows) {
        const rotulos = (porTarefa.get(r.clickup_task_id) ?? []).slice(0, 3);   // teto 3, e o banco confirma
        await cli.query('BEGIN');
        try {
          for (let i = 0; i < rotulos.length; i++) {
            await cli.query(
              `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label, source)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [r.id, CAMPO, i + 1, rotulos[i], SOURCE]);
          }
          await cli.query('COMMIT'); gravados++;
        } catch (e) { await cli.query('ROLLBACK'); throw e; }
      }
      console.log(`\nGRAVADOS: ${gravados} paciente(s)`);
    }

    console.log(`\n── ROLLBACK (pronto para colar) ──`);
    console.log(`DELETE FROM patient_source_labels WHERE source = '${SOURCE}';`);
    console.log(`-- nada em \`patients\` foi tocado: o derivado não entra neste script.`);
  } finally { cli.release(); await pool.end(); }
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
