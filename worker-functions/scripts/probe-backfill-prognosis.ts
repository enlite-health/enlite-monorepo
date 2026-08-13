/**
 * probe-backfill-prognosis.ts — PROGNÓSTICO DO BACKFILL DE CHAT IDs.
 * SOMENTE LEITURA, em produção.
 *
 * Por que existe: antes de rodar o backfill dos chat IDs (ClickUp 86ajy085b) a
 * gente precisa saber quanto dele vai sair em dois cliques e quanto vai exigir
 * trabalho manual. Sem isso, "vamos popular a base" é aposta.
 *
 * A pergunta que este script responde, com número: para cada paciente ativo,
 * quantos grupos do Periskope o ranqueamento traria como candidato plausível?
 *
 * ⚠️ Este número já foi reportado uma vez (88,8%) SEM script que o produzisse —
 * afirmação sem artefato. Este arquivo existe para que o número seja refazível
 * por qualquer pessoa, a qualquer momento, e comparável ao longo do tempo.
 *
 * 🚨 NUNCA ESCREVE. Postgres: só SELECT. Periskope: só `GET /chats`, via
 * `PeriskopeChatReadService`, que não expõe caminho de escrita.
 *
 * 🔒 NUNCA IMPRIME PII. Nome de paciente e nome de grupo entram na comparação em
 * memória e NUNCA na saída. O que sai é histograma e percentual — nada
 * individual, nada que identifique alguém (Ley 25.326).
 *
 * Uso:
 *   # 1. proxy para a instância de produção
 *   cloud-sql-proxy enlite-prd:southamerica-west1:enlite-ar-db --port 5435 &
 *
 *   # 2. rodar
 *   DATABASE_URL='postgresql://<user>:<pass>@127.0.0.1:5435/<db>' \
 *   PERISKOPE_API_KEY=$(gcloud secrets versions access latest \
 *     --secret=periskope-api-key --project=enlite-prd) \
 *   PERISKOPE_PHONE=<numero conectado> \
 *   npx ts-node -r tsconfig-paths/register scripts/probe-backfill-prognosis.ts
 *
 * Exit 0 = mediu. Exit 1 = faltou credencial/conexão (não mede pela metade).
 */

import { Pool } from 'pg';
import { PeriskopeChatReadService } from '@modules/notification';
import { rankChatCandidates } from '@modules/case/application/rankChatCandidates';

/** Quantos candidatos o operador vê na tela — o mesmo default da UI. */
const UI_LIMIT = 10;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL ausente. Suba o cloud-sql-proxy e exporte a URL.');
    process.exit(1);
  }

  // ── 1. Grupos do Periskope (leitura) ──────────────────────────────────────
  const periskope = new PeriskopeChatReadService();
  if (!periskope.isConfigured) {
    console.error('❌ Periskope sem credencial (PERISKOPE_API_KEY / PERISKOPE_PHONE).');
    process.exit(1);
  }

  const listed = await periskope.listGroupChats();
  if (listed === null) {
    console.error('❌ Não foi possível listar os grupos do Periskope.');
    process.exit(1);
  }
  const { groups, truncated } = listed;

  // ── 2. Pacientes ativos (leitura) ─────────────────────────────────────────
  const pool = new Pool({ connectionString: databaseUrl });
  let pacientes: Array<{ nome: string; jaVinculado: boolean }>;
  try {
    const res = await pool.query<{
      first_name: string | null;
      last_name: string | null;
      family_chat_id: string | null;
      providers_chat_id: string | null;
    }>(
      `SELECT first_name, last_name, family_chat_id, providers_chat_id
         FROM patients
        WHERE deleted_at IS NULL AND status = 'ACTIVE'`,
    );
    pacientes = res.rows.map(r => ({
      nome: [r.first_name, r.last_name].filter(Boolean).join(' ').trim(),
      jaVinculado: Boolean(r.family_chat_id || r.providers_chat_id),
    }));
  } catch (err) {
    // A coluna pode não existir ainda em prod (migration 260 não aplicada).
    const msg = err instanceof Error ? err.message : String(err);
    if (!/family_chat_id|providers_chat_id/.test(msg)) throw err;
    const res = await pool.query<{ first_name: string | null; last_name: string | null }>(
      `SELECT first_name, last_name
         FROM patients
        WHERE deleted_at IS NULL AND status = 'ACTIVE'`,
    );
    pacientes = res.rows.map(r => ({
      nome: [r.first_name, r.last_name].filter(Boolean).join(' ').trim(),
      jaVinculado: false,
    }));
    console.log('ℹ️  migration 260 ainda não aplicada nesta base — medindo a base inteira.\n');
  } finally {
    await pool.end();
  }

  // ── 3. Medição (em memória; nada individual sai) ──────────────────────────
  const semNome = pacientes.filter(p => !p.nome).length;
  const mediveis = pacientes.filter(p => p.nome);

  const histograma = new Map<number, number>(); // nº de candidatos → nº de pacientes
  let comDoisOuMais = 0;
  let comAlgum = 0;

  for (const p of mediveis) {
    const n = rankChatCandidates({
      patientName: p.nome,
      groups,
      linkedElsewhere: new Set<string>(),
      limit: UI_LIMIT,
    }).length;

    histograma.set(n, (histograma.get(n) ?? 0) + 1);
    if (n >= 2) comDoisOuMais++;
    if (n >= 1) comAlgum++;
  }

  const pct = (n: number): string =>
    mediveis.length === 0 ? '—' : `${((n / mediveis.length) * 100).toFixed(1)}%`;

  // ── 4. Saída: só agregados ────────────────────────────────────────────────
  console.log('PROGNÓSTICO DO BACKFILL DE CHAT IDs — somente leitura');
  console.log(`data: ${new Date().toISOString()}`);
  console.log('-'.repeat(78));
  console.log(`grupos lidos do Periskope              : ${groups.length}${truncated ? ' ⚠️ LISTA INCOMPLETA' : ''}`);
  console.log(`pacientes ativos                       : ${pacientes.length}`);
  console.log(`  sem nome no cadastro (não mensurável): ${semNome}`);
  console.log(`  mensuráveis                          : ${mediveis.length}`);
  console.log(`  já vinculados                        : ${pacientes.filter(p => p.jaVinculado).length}`);
  console.log('-'.repeat(78));
  console.log(`com 2+ candidatos (resolve em 2 cliques): ${comDoisOuMais}  (${pct(comDoisOuMais)})`);
  console.log(`com 1 candidato   (escolha parcial)     : ${comAlgum - comDoisOuMais}  (${pct(comAlgum - comDoisOuMais)})`);
  console.log(`com 0 candidatos  (trabalho manual)     : ${mediveis.length - comAlgum}  (${pct(mediveis.length - comAlgum)})`);
  console.log('-'.repeat(78));
  console.log('histograma (candidatos → pacientes):');
  for (const n of [...histograma.keys()].sort((a, b) => a - b)) {
    const qtd = histograma.get(n) ?? 0;
    console.log(`  ${String(n).padStart(2)} candidato(s): ${String(qtd).padStart(4)}  ${'█'.repeat(Math.round((qtd / mediveis.length) * 50))}`);
  }
  console.log('-'.repeat(78));
  console.log('nenhum nome de paciente, nome de grupo ou chat_id foi impresso (PII, Ley 25.326)');

  if (truncated) {
    console.log('\n⚠️ A lista de grupos veio INCOMPLETA — os números acima são piso, não retrato.');
  }
}

main().catch(err => {
  console.error('❌ falhou:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
