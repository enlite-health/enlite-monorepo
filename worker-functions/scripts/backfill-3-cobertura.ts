/**
 * backfill-3-cobertura.ts — a task 3.6 da Fase 3.
 *
 * Preenche `patient_insurance_verified` a partir do ClickUp. Esperado: **345** (F34,
 * reconferido em 24/08: 4 vazios · 344 com 1 valor · 1 com 2 · cobertura 349/349).
 *
 * ⚠️ NÃO deriva do escalar `patients.insurance_verified`: ele está VAZIO (0 de 349, F5), que
 * é a razão desta fase existir. A fonte é o ClickUp, somente `GET`.
 *
 * Leitura ILEGÍVEL não entra (D167): "não consegui ler" nunca vira dado.
 *
 * `--dry-run` é o DEFAULT. `--executar` exige `--esperado` e recusa se o obtido divergir —
 * divergência é fato sobre a realidade, não número a atualizar.
 *
 * Alvo não-local exige `--eu-sei-que-e-producao`, deliberadamente desconfortável de digitar.
 *
 * Rollback, impresso em toda corrida:
 *   DELETE FROM patient_insurance_verified WHERE source = 'backfill-3';
 * O escalar não é tocado por este script.
 */
import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { resolveCatalogValue } from '../src/modules/integration/infrastructure/clickup/helpers/resolveCatalogValue';
import { classifyInsuranceLabels } from '../src/modules/case';
import { assertBackfillWriteTarget } from '../src/shared/database/assertLocalDatabaseTarget';

const LIST_ID = '901304883903';
const CAMPO   = 'Cobertura Verificada';
const SOURCE  = 'backfill-3';
const API     = 'https://api.clickup.com/api/v2';

const arg = (n: string) => process.argv.includes(n);
const val = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

/**
 * A trava de alvo deste backfill é a MESMA de `src/shared/database` — REUSADA, nunca copiada.
 *
 * 🔴 Havia aqui uma cópia local com o regex terminando em `(\?|$)`. Medido no gate F5 (D1):
 * ela classificava `…@localhost:5432/enlite_e2e?port=5436` como "LOCAL (docker)" enquanto o
 * `pg` conectava na 5436 (PRD), e `…?host=/cloudsql/…` como local enquanto o `pg` conectava no
 * Cloud SQL de PRODUÇÃO. Este script ESCREVE em linha de paciente. Três cópias divergiram da
 * trava testada — o conserto é não ter cópia.
 *
 * `--eu-sei-que-e-producao` segue valendo (amplia os ALVOS aceitos) e NÃO desarma a recusa de
 * query string nem a de socket `/cloudsql/`. Ver `assertBackfillWriteTarget`.
 */
export const travaDeAlvo = assertBackfillWriteTarget;

async function main(): Promise<void> {
  const executar = arg('--executar');
  const prod     = arg('--eu-sei-que-e-producao');
  const esperado = val('--esperado') ? Number(val('--esperado')) : undefined;
  console.log(`ALVO: ${travaDeAlvo(process.env.DATABASE_URL, prod)}`);
  console.log(`MODO: ${executar ? 'EXECUTAR (escreve)' : 'DRY-RUN (não escreve nada)'}`);
  console.log(`ESPERADO DECLARADO: ${esperado ?? '(não declarado)'}`);
  if (executar && esperado === undefined) throw new Error('--executar exige --esperado (3.6)');

  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN ausente');

  const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token });
  const porTarefa = new Map<string, string[]>();
  let pagina = 0, lidas = 0, ilegiveis = 0;
  for (;;) {
    const q = new URLSearchParams({ page: String(pagina), archived: 'false', include_closed: 'false', subtasks: 'false' });
    const res = await fetch(`${API}/list/${LIST_ID}/task?${q}`, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`ClickUp /task HTTP ${res.status}`);
    const d = await res.json() as { tasks: Array<{ id: string; custom_fields: Array<{ name: string; value?: unknown }> }>; last_page?: boolean };
    for (const t of d.tasks) {
      lidas++;
      const cf = Object.fromEntries(t.custom_fields.map(f => [f.name, f.value]));
      const leitura = resolveCatalogValue(resolver, CAMPO, cf[CAMPO], { warn: false });
      if (!leitura.readable) { ilegiveis++; continue; }          // D167: ilegível NÃO entra
      const { accepted } = classifyInsuranceLabels(leitura.labels);
      if (accepted.length > 0) porTarefa.set(t.id, accepted);
    }
    if (d.last_page || d.tasks.length === 0) break;
    pagina++;
    if (pagina > 200) throw new Error('parei em 200 páginas — leitura PARCIAL não serve para backfill (M46)');
  }
  console.log(`\nClickUp: ${lidas} tarefa(s) viva(s); ${porTarefa.size} com cobertura legível; ${ilegiveis} ilegível(is)`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli  = await pool.connect();
  try {
    console.log(`ALVO MEDIDO CONTRA O SERVIDOR: db=${(await cli.query('select current_database() d')).rows[0].d}`);
    const alvos = await cli.query<{ id: string; clickup_task_id: string }>(
      `SELECT p.id, p.clickup_task_id FROM patients p
        WHERE p.clickup_task_id = ANY($1) AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM patient_insurance_verified v WHERE v.patient_id = p.id)`,
      [[...porTarefa.keys()]]);

    const obtido = alvos.rows.length;
    console.log(`\nOBTIDO: ${obtido} paciente(s) sem cobertura no banco e com cobertura legível na origem`);
    console.log(`ESPERADO: ${esperado ?? '(não declarado)'}   ⇒ ${esperado === undefined ? 'sem comparação' : (obtido === esperado ? 'BATE' : 'DIVERGE')}`);

    if (obtido === 0) { console.log('\nFALHA: zero a preencher — contagem zero é FALHA, nunca sucesso (F19)'); process.exit(1); }
    if (esperado !== undefined && obtido !== esperado) {
      console.log('\nFALHA: obtido ≠ esperado. O backfill NÃO roda com contagem divergente.');
      if (executar) process.exit(1);
    }

    if (!executar) {
      console.log('\nDRY-RUN: nada foi escrito. Para executar: --executar --esperado <n>');
    } else {
      let gravados = 0, linhas = 0;
      for (const r of alvos.rows) {
        const labels = porTarefa.get(r.clickup_task_id) ?? [];
        await cli.query('BEGIN');
        try {
          for (let i = 0; i < labels.length; i++) {
            await cli.query(
              `INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source)
               VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [r.id, i + 1, labels[i], SOURCE]);
            linhas++;
          }
          await cli.query('COMMIT'); gravados++;
        } catch (e) { await cli.query('ROLLBACK'); throw e; }
      }
      console.log(`\nGRAVADOS: ${gravados} paciente(s), ${linhas} linha(s) de cobertura`);
    }

    console.log(`\n── ROLLBACK (pronto para colar) ──`);
    console.log(`DELETE FROM patient_insurance_verified WHERE source = '${SOURCE}';`);
    console.log(`-- \`patients.insurance_verified\` (o escalar) não é tocado por este script.`);
  } finally { cli.release(); await pool.end(); }
}
/* istanbul ignore next -- entrypoint do CLI: só roda fora de teste (require.main === module) */
if (require.main === module) {
  main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
