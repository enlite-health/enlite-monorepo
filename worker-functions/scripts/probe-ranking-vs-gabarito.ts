/**
 * probe-ranking-vs-gabarito.ts — MEDE ACERTO do ranqueamento contra o
 * mapeamento feito à mão pelo Marcel. SOMENTE LEITURA (GET /chats).
 *
 * Por que existe: "cobertura" ("acha 2+ candidatos para 90,6%") não é ACERTO
 * ("o candidato certo está em primeiro?"). A planilha do Marcel é o gabarito.
 *
 * O que responde, por papel (FAMILIA / EQUIPO), ANTES e DEPOIS do desempate:
 *   - o grupo que o Marcel escolheu aparece na nossa lista de candidatos?
 *   - em que POSIÇÃO? (1º = a pessoa só confirma; 5º = ela procura)
 *
 * ANTES  = `rankChatCandidates` sozinho (empate resolvido por ordem alfabética
 *          do nome do grupo — o que estava em produção).
 * DEPOIS = o mesmo ranking, reordenado por `orderCandidatesForRole` com as
 *          `match_keywords` do catálogo (migration 262).
 *
 * A invariante ("afinidade só desempata score IGUAL") prevê que a linha
 * "NÃO apareceu" e a do "top 3" NÃO podem mudar — só a de 1º lugar. O relatório
 * imprime as três justamente para que a previsão seja falseável.
 *
 * 🔒 Saída só agregada. Nenhum nome de paciente, nome de grupo ou chat_id.
 *
 * Uso:
 *   PERISKOPE_API_KEY=... PERISKOPE_PHONE=... \
 *   GABARITO_JSON=/caminho/gabarito.json \
 *   npx ts-node --files -r tsconfig-paths/register scripts/probe-ranking-vs-gabarito.ts
 *
 * O JSON é gerado da planilha (ver bloco python no diário) no formato:
 *   [{ "nome": "...", "family": "...@g.us"|null, "providers": "...@g.us"|null }]
 */

import { readFileSync } from 'fs';
import { PeriskopeChatReadService } from '@modules/notification';
import {
  rankChatCandidates,
  orderCandidatesForRole,
  type RoleMatchSpec,
} from '@modules/case/application/rankChatCandidates';

const UI_LIMIT = 10;

/**
 * As `match_keywords` como a migration 262 as semeia. Ficam aqui, e não lidas do
 * banco, para a medição não depender de uma instância — e para que rodar de novo
 * amanhã, em outra máquina, dê o mesmo número.
 */
const FAMILY: RoleMatchSpec = {
  code: 'FAMILY',
  matchKeywords: ['flia', 'familia', 'family', 'fam', 'familiares'],
};
const PROVIDERS: RoleMatchSpec = {
  code: 'PROVIDERS',
  matchKeywords: ['equipo', 'equipe', 'prestadores', 'prestador', 'acompanantes', 'ats'],
};
const HEALTH_PLAN: RoleMatchSpec = {
  code: 'HEALTH_PLAN',
  matchKeywords: ['obra', 'social', 'prepaga', 'osde', 'swiss', 'galeno', 'plan'],
};
const ROLES = [FAMILY, PROVIDERS, HEALTH_PLAN];

interface Linha {
  nome: string;
  family: string | null;
  providers: string | null;
}

/** Posição do alvo (1-based) ou 0 quando não apareceu. */
function posicaoEm(alvo: string, ordenados: { chatId: string }[]): number {
  const idx = ordenados.findIndex(c => c.chatId === alvo);
  return idx === -1 ? 0 : idx + 1;
}

function medir(
  alvo: string,
  nome: string,
  role: RoleMatchSpec,
  groups: Parameters<typeof rankChatCandidates>[0]['groups'],
): { antes: number; depois: number } {
  const ranked = rankChatCandidates({
    patientName: nome,
    groups,
    linkedElsewhere: new Set<string>(),
    limit: UI_LIMIT,
  });
  return {
    antes: posicaoEm(alvo, ranked),
    depois: posicaoEm(alvo, orderCandidatesForRole(ranked, role, ROLES)),
  };
}

interface Resumo {
  total: number;
  primeiro: number;
  top3: number;
  apareceu: number;
}

function resumir(posicoes: number[]): Resumo {
  return {
    total: posicoes.length,
    primeiro: posicoes.filter(p => p === 1).length,
    top3: posicoes.filter(p => p >= 1 && p <= 3).length,
    apareceu: posicoes.filter(p => p > 0).length,
  };
}

function linhaComparada(rotulo: string, a: number, d: number, total: number): string {
  const pct = (n: number) => (total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`);
  const delta = d - a;
  const seta = delta > 0 ? `  ▲ +${delta}` : delta < 0 ? `  ▼ ${delta}` : '   =';
  return `  ${rotulo.padEnd(28)} ${String(a).padStart(3)} (${pct(a)})  ->  ${String(d).padStart(3)} (${pct(d)})${seta}`;
}

function relatorio(titulo: string, antes: number[], depois: number[]): void {
  const total = antes.length;
  if (total === 0) {
    console.log(`\n${titulo}: sem casos no gabarito`);
    return;
  }
  const a = resumir(antes);
  const d = resumir(depois);

  console.log(`\n${titulo} — ${total} casos no gabarito`);
  console.log('                                 ANTES            DEPOIS');
  console.log(linhaComparada('em 1º lugar (só confirmar)', a.primeiro, d.primeiro, total));
  console.log(linhaComparada('no top 3', a.top3, d.top3, total));
  console.log(linhaComparada('apareceu em algum lugar', a.apareceu, d.apareceu, total));
  console.log(linhaComparada('NÃO apareceu (falha real)', total - a.apareceu, total - d.apareceu, total));

  // Prova da invariante: nenhum caso pode ENTRAR ou SAIR da lista, e o top 3 é
  // um conjunto fechado sob reordenação por empate.
  const entrouOuSaiu = antes.filter((p, i) => (p === 0) !== (depois[i] === 0)).length;
  const top3Mudou = antes.filter((p, i) => (p >= 1 && p <= 3) !== (depois[i] >= 1 && depois[i] <= 3)).length;
  console.log(`  invariante: casos que entraram/saíram da lista = ${entrouOuSaiu} (esperado 0)`);
  console.log(`  invariante: casos que entraram/saíram do top 3 = ${top3Mudou} (esperado 0)`);

  const hist = new Map<number, { a: number; d: number }>();
  const bump = (p: number, campo: 'a' | 'd') => {
    if (p === 0) return;
    const cur = hist.get(p) ?? { a: 0, d: 0 };
    cur[campo] += 1;
    hist.set(p, cur);
  };
  antes.forEach(p => bump(p, 'a'));
  depois.forEach(p => bump(p, 'd'));
  console.log('  posições (antes -> depois):');
  for (const p of [...hist.keys()].sort((x, y) => x - y)) {
    const { a: na, d: nd } = hist.get(p)!;
    console.log(`    ${String(p).padStart(2)}º: ${String(na).padStart(3)} -> ${String(nd).padStart(3)}`);
  }
}

async function main(): Promise<void> {
  const gabaritoPath = process.env.GABARITO_JSON;
  if (!gabaritoPath) {
    console.error('❌ GABARITO_JSON ausente.');
    process.exit(1);
  }

  const periskope = new PeriskopeChatReadService();
  if (!periskope.isConfigured) {
    console.error('❌ Periskope sem credencial.');
    process.exit(1);
  }
  const listed = await periskope.listGroupChats();
  if (listed === null) {
    console.error('❌ Não foi possível listar os grupos.');
    process.exit(1);
  }
  const { groups, truncated } = listed;

  const linhas: Linha[] = JSON.parse(readFileSync(gabaritoPath, 'utf8'));

  const famAntes: number[] = [];
  const famDepois: number[] = [];
  const preAntes: number[] = [];
  const preDepois: number[] = [];
  let semNome = 0;

  for (const l of linhas) {
    if (!l.nome?.trim()) { semNome++; continue; }
    if (l.family) {
      const { antes, depois } = medir(l.family, l.nome, FAMILY, groups);
      famAntes.push(antes);
      famDepois.push(depois);
    }
    if (l.providers) {
      const { antes, depois } = medir(l.providers, l.nome, PROVIDERS, groups);
      preAntes.push(antes);
      preDepois.push(depois);
    }
  }

  console.log('ACERTO DO RANQUEAMENTO CONTRA O GABARITO DO MARCEL');
  console.log(`data: ${new Date().toISOString()}`);
  console.log('-'.repeat(78));
  console.log(`grupos lidos do Periskope : ${groups.length}${truncated ? ' ⚠️ INCOMPLETA' : ''}`);
  console.log(`linhas do gabarito        : ${linhas.length}`);
  console.log(`  sem nome (ignoradas)    : ${semNome}`);
  console.log(`teto de candidatos da tela: ${UI_LIMIT}`);
  console.log('DEPOIS = com desempate por match_keywords do catálogo (migration 262)');

  relatorio('GRUPO DE PRESTADORES (EQUIPO)', preAntes, preDepois);
  relatorio('GRUPO DA FAMÍLIA (FAMILIA)', famAntes, famDepois);

  console.log('\n' + '-'.repeat(78));
  console.log('nenhum nome ou chat_id impresso (PII, Ley 25.326)');
}

main().catch(err => {
  console.error('❌ falhou:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
