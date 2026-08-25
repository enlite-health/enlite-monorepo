/**
 * backfill-4.2-dispositivo.ts — a task 4.5 da Fase 4, para `Tipo de Dispositivo`.
 *
 * Preenche `patient_device_types` a partir do ClickUp. Esperado: **253** (F35, medição de
 * 24/08 sobre os 349 vivos: 221 com 1 valor · 30 com 2 · 2 com 3).
 *
 * ⚠️ NÃO deriva do escalar `patients.device_type`: ele está VAZIO (0 de 408, re-medido em
 * 25/08), que é parte da razão desta fase existir. A fonte é o ClickUp, somente `GET`.
 *
 * ── A diferença em relação ao backfill da cobertura, e ela é estrutural ─────
 * A cobertura grava o rótulo CRU e aceita qualquer string não-vazia. Aqui a coluna tem **FK
 * para `device_types(code)`** (migration 287): o rótulo em espanhol precisa ser TRADUZIDO
 * pelo ConceptMap (`device_type_aliases`) antes de virar linha, e o que não traduz **não pode
 * ser inserido** — seria `23503` no meio do laço, derrubando o backfill inteiro no primeiro
 * rótulo novo que a operação tenha criado.
 *
 * ⇒ Este script **conta e NOMEIA os não-traduzíveis antes de escrever qualquer coisa**, e
 * recusa executar se houver algum. Motivo: um rótulo desconhecido no meio de um backfill de
 * 253 pacientes não é exceção a tratar, é sinal de que o ConceptMap está desatualizado — e a
 * resposta certa é acrescentar o alias, não engolir o valor. (No caminho do SYNC, o mesmo
 * rótulo vai para quarentena e o paciente segue: lá o custo de parar é um webhook; aqui é a
 * migração inteira ficar pela metade, que é pior que não começar.)
 *
 * ── O escalar NÃO é escrito por este script ────────────────────────────────
 * `patients.device_type` é derivado por trigger (migration 290). Cada INSERT aqui dispara o
 * recálculo. Depois de rodar, conferir com `scripts/verificar-4.2-divergencia.ts`.
 *
 * `--dry-run` é o DEFAULT. `--executar` exige `--esperado` e recusa se o obtido divergir —
 * divergência é fato sobre a realidade, não número a atualizar.
 *
 * Alvo não-local exige `--eu-sei-que-e-producao`, deliberadamente desconfortável de digitar.
 *
 * Rollback, impresso em toda corrida:
 *   DELETE FROM patient_device_types WHERE source = 'backfill-4.2';
 * ⚠️ Apagar essas linhas faz o trigger recalcular o escalar para NULL — que é o estado de
 * antes. O rollback é completo sem tocar em `patients`.
 */
import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { resolveCatalogValue } from '../src/modules/integration/infrastructure/clickup/helpers/resolveCatalogValue';

const LIST_ID = '901304883903';
const CAMPO   = 'Tipo de Dispositivo';
const SOURCE  = 'backfill-4.2';
const API     = 'https://api.clickup.com/api/v2';

const arg = (n: string) => process.argv.includes(n);
const val = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

function travaDeAlvo(url: string | undefined, prodOk: boolean): string {
  if (!url) throw new Error('DATABASE_URL ausente — sem alvo não há backfill (e ausência não é local)');
  if (/@(localhost|127\.0\.0\.1):(5432|5433)\/enlite_e2e(\?|$)/.test(url)) return 'LOCAL (docker)';
  if (prodOk) return 'NÃO-LOCAL, autorizado explicitamente';
  throw new Error('ALVO RECUSADO: este script escreve em linha de paciente. Alvo não-local exige --eu-sei-que-e-producao');
}

async function main(): Promise<void> {
  const executar = arg('--executar');
  const prod     = arg('--eu-sei-que-e-producao');
  const esperado = val('--esperado') ? Number(val('--esperado')) : undefined;
  console.log(`ALVO: ${travaDeAlvo(process.env.DATABASE_URL, prod)}`);
  console.log(`MODO: ${executar ? 'EXECUTAR (escreve)' : 'DRY-RUN (não escreve nada)'}`);
  console.log(`ESPERADO DECLARADO: ${esperado ?? '(não declarado)'}`);
  if (executar && esperado === undefined) throw new Error('--executar exige --esperado (4.5)');

  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN ausente');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const cli  = await pool.connect();
  try {
    console.log(`ALVO MEDIDO CONTRA O SERVIDOR: db=${(await cli.query('select current_database() d')).rows[0].d}`);

    // O ConceptMap vem do BANCO, não de constante — mesma razão do repositório: catálogo
    // editável sem deploy. Se o alias novo já foi criado, o backfill o enxerga na hora.
    const aliases = await cli.query<{ label: string; code: string }>(
      `SELECT label, code FROM device_type_aliases WHERE source = 'clickup'`);
    const porRotulo = new Map(aliases.rows.map(r => [r.label, r.code]));
    console.log(`ConceptMap: ${porRotulo.size} rótulo(s) traduzível(is)`);
    if (porRotulo.size === 0) throw new Error('ConceptMap VAZIO — a migration 287 não rodou neste alvo');

    const resolver = await ClickUpFieldResolver.fromList(LIST_ID, { token });
    const porTarefa = new Map<string, string[]>();
    const naoTraduzidos = new Map<string, number>();
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
        const codes: string[] = [];
        const vistos = new Set<string>();
        for (const l of leitura.labels) {
          if (typeof l !== 'string' || l.trim() === '') continue;
          const code = porRotulo.get(l);
          if (!code) { naoTraduzidos.set(l, (naoTraduzidos.get(l) ?? 0) + 1); continue; }
          if (vistos.has(code)) continue;
          vistos.add(code); codes.push(code);
        }
        if (codes.length > 0) porTarefa.set(t.id, codes);
      }
      if (d.last_page || d.tasks.length === 0) break;
      pagina++;
      if (pagina > 200) throw new Error('parei em 200 páginas — leitura PARCIAL não serve para backfill (M46)');
    }
    console.log(`\nClickUp: ${lidas} tarefa(s) viva(s); ${porTarefa.size} com dispositivo traduzível; ${ilegiveis} ilegível(is)`);

    // ⚠️ A trava que a FK obriga. Rótulos NOMEADOS de propósito: são termos de CATÁLOGO da
    // operação (`Domiciliario`, `Escolar`…), não valor clínico de um paciente — imprimir o
    // termo é o que permite acrescentar o alias. A contagem por termo não identifica ninguém.
    if (naoTraduzidos.size > 0) {
      console.log(`\n⚠️ ${naoTraduzidos.size} rótulo(s) SEM tradução no ConceptMap:`);
      for (const [r, n] of [...naoTraduzidos].sort((a, b) => b[1] - a[1])) {
        console.log(`     ${JSON.stringify(r).padEnd(34)} em ${n} tarefa(s)`);
      }
      console.log(`   Conserto: INSERT em device_type_aliases (source, label, code) e rodar de novo.`);
      if (executar) { console.log('\nFALHA: o backfill NÃO roda com rótulo sem tradução.'); process.exit(1); }
    }

    const alvos = await cli.query<{ id: string; clickup_task_id: string }>(
      `SELECT p.id, p.clickup_task_id FROM patients p
        WHERE p.clickup_task_id = ANY($1) AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM patient_device_types v WHERE v.patient_id = p.id)`,
      [[...porTarefa.keys()]]);

    const obtido = alvos.rows.length;
    console.log(`\nOBTIDO: ${obtido} paciente(s) sem dispositivo no banco e com dispositivo legível na origem`);
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
        const codes = porTarefa.get(r.clickup_task_id) ?? [];
        await cli.query('BEGIN');
        try {
          for (const code of codes) {
            await cli.query(
              `INSERT INTO patient_device_types (patient_id, device_type, source)
               VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [r.id, code, SOURCE]);
            linhas++;
          }
          await cli.query('COMMIT'); gravados++;
        } catch (e) { await cli.query('ROLLBACK'); throw e; }
      }
      console.log(`\nGRAVADOS: ${gravados} paciente(s), ${linhas} linha(s) de dispositivo`);
      console.log(`O escalar foi recalculado pelo TRIGGER, não por este script.`);
      console.log(`CONFERIR AGORA: npx ts-node -r tsconfig-paths/register scripts/verificar-4.2-divergencia.ts`);
    }

    console.log(`\n── ROLLBACK (pronto para colar) ──`);
    console.log(`DELETE FROM patient_device_types WHERE source = '${SOURCE}';`);
    console.log(`-- o trigger recalcula \`patients.device_type\` para NULL sozinho; não tocar em patients.`);
  } finally { cli.release(); await pool.end(); }
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
