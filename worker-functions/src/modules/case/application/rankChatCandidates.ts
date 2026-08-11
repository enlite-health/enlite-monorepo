import type { PeriskopeGroupChat } from '@modules/notification';

/**
 * Ranqueamento de grupos do Periskope por semelhança com o nome do paciente.
 *
 * REGRA DE OURO: **ranqueia, nunca escolhe.** Qual dos grupos é o da família e
 * qual é o dos prestadores é decisão do humano — o custo de errar é auditoria
 * errada na Candela, e o nome do grupo não carrega essa informação de forma
 * confiável. Por isso nada aqui olha para palavras como "família"/"prestadores":
 * a única dimensão pontuada é semelhança com o NOME DO PACIENTE.
 *
 * Funções puras, sem I/O e sem log — o nome do paciente e o nome do grupo são
 * PII (Ley 25.326) e nunca saem daqui.
 */

/** Um grupo candidato, já pontuado. */
export interface ChatCandidate {
  chatId: string;
  chatName: string | null;
  memberCount: number | null;
  /** 0..1 — fração dos termos do nome do paciente encontrados no nome do grupo. */
  score: number;
  /** Quais termos do nome do paciente bateram (transparência para o operador). */
  matchedTerms: string[];
  /** true quando este grupo já está preso a OUTRO paciente. */
  linkedToOtherPatient: boolean;
  /**
   * O NOME INTEIRO do paciente aparece contíguo no nome do grupo (ex.: "Maria
   * Perez" dentro de "Flia Maria Perez") — sinal mais forte que os mesmos
   * termos espalhados. Critério de DESEMPATE em `rankChatCandidates`, separado
   * do `score` — ver a nota em `scoreGroupName` sobre por que não é somado ao
   * score.
   */
  contiguousBonus: boolean;
}

/**
 * Termos genéricos de nome de grupo/pessoa que não distinguem paciente nenhum.
 * Sem isso, "Grupo de la flia. Pérez" empataria com qualquer outro "grupo".
 * Já sem acento — a comparação roda depois de `normalizeForMatch`.
 */
const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'da', 'do', 'dos', 'das',
  'y', 'e', 'con', 'para', 'sr', 'sra', 'don', 'na', 'no', 'um', 'uma',
  'grupo', 'grupos', 'flia', 'fam', 'familia', 'familiares',
  'prestadores', 'prestador', 'equipo', 'equipe', 'caso', 'paciente',
  'enlite', 'at', 'ats', 'acompanantes',
]);

/** Comprimento mínimo para um termo prefixar/ser prefixado por outro. */
const PREFIX_MIN_LENGTH = 4;

/** minúsculas, sem acento, só letras e dígitos separados por espaço. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Termos úteis de um nome: ≥2 caracteres, sem stopword, sem repetição. */
export function toMatchTerms(value: string): string[] {
  const seen = new Set<string>();
  for (const term of normalizeForMatch(value).split(' ')) {
    if (term.length >= 2 && !STOPWORDS.has(term)) seen.add(term);
  }
  return [...seen];
}

function matchesTerm(term: string, groupTerms: string[]): boolean {
  return groupTerms.some(g => {
    if (g === term) return true;
    // Prefixo em qualquer direção cobre abreviação ("rodrig" ↔ "rodriguez")
    // e sufixo colado ("perezz"). Só a partir de 4 caracteres, senão "an"
    // casaria com meio dicionário.
    if (term.length >= PREFIX_MIN_LENGTH && g.startsWith(term)) return true;
    if (g.length >= PREFIX_MIN_LENGTH && term.startsWith(g)) return true;
    return false;
  });
}

/**
 * Pontua um nome de grupo contra os termos do nome do paciente.
 * Retorna `score` (0..1), os termos que bateram, e o bônus de contiguidade.
 *
 * ⚠️ Achado de review (11/08): o bônus de nome-inteiro-contíguo (`+0.25`) só
 * consegue se aplicar quando `base` JÁ é 1 na prática (ver nota abaixo), mas a
 * versão antiga fazia `Math.min(1, base + bonus)` — travando o resultado em 1
 * de qualquer forma. O bônus nunca mudava o score final nem o desempate,
 * apesar do comentário dizer "sinal mais forte": dois grupos com os MESMOS
 * termos, um contíguo ("Flia Maria Perez") e outro espalhado ("Perez, Maria"),
 * empatavam em score=1 e o desempate voltava a ser alfabético — exatamente o
 * problema que este sinal existe para resolver.
 *
 * Por que o bônus só se aplica com `base` já em 1: `contiguous` é o nome
 * INTEIRO do paciente (todos os termos, em ordem, com um espaço). Se essa
 * string aparece como substring do nome do grupo, cada termo individual
 * também aparece — então `matchedTerms` bate todos e `base` já é 1. Dado isso,
 * somar ao score e clampar é matematicamente incapaz de diferenciar: a saída
 * certa é um critério de DESEMPATE separado, não uma soma pré-clamp — é o que
 * `contiguousBonus` vira aqui, consumido em `rankChatCandidates`.
 */
export function scoreGroupName(
  patientTerms: string[],
  groupName: string | null,
): { score: number; matchedTerms: string[]; contiguousBonus: boolean } {
  if (patientTerms.length === 0 || !groupName) {
    return { score: 0, matchedTerms: [], contiguousBonus: false };
  }

  const groupTerms = normalizeForMatch(groupName).split(' ').filter(Boolean);
  if (groupTerms.length === 0) return { score: 0, matchedTerms: [], contiguousBonus: false };

  const matchedTerms = patientTerms.filter(t => matchesTerm(t, groupTerms));
  if (matchedTerms.length === 0) return { score: 0, matchedTerms: [], contiguousBonus: false };

  const score = matchedTerms.length / patientTerms.length;

  const contiguous = normalizeForMatch(patientTerms.join(' '));
  const contiguousBonus = normalizeForMatch(groupName).includes(contiguous);

  return { score: Number(score.toFixed(4)), matchedTerms, contiguousBonus };
}

export interface RankChatCandidatesInput {
  /** Nome do paciente como está no cadastro (first + last). */
  patientName: string;
  groups: PeriskopeGroupChat[];
  /** chat_ids já presos a OUTROS pacientes. */
  linkedElsewhere?: ReadonlySet<string>;
  /** Quantos devolver. */
  limit: number;
}

/**
 * Ordena os grupos por semelhança com o nome do paciente e devolve os `limit`
 * melhores. Grupo com score 0 não entra — devolver a lista inteira de 774
 * grupos "por via das dúvidas" só empurra a decisão errada para o operador.
 *
 * Desempate: 1º `contiguousBonus` (o nome inteiro do paciente aparece contíguo
 * no nome do grupo — sinal mais forte que os mesmos termos espalhados), depois
 * nome do grupo (ordem estável e reproduzível), nunca pela ordem em que o
 * Periskope devolveu.
 */
export function rankChatCandidates(input: RankChatCandidatesInput): ChatCandidate[] {
  const patientTerms = toMatchTerms(input.patientName);
  const linked = input.linkedElsewhere ?? new Set<string>();

  return input.groups
    .map(g => {
      const { score, matchedTerms, contiguousBonus } = scoreGroupName(patientTerms, g.chatName);
      return {
        chatId: g.chatId,
        chatName: g.chatName,
        memberCount: g.memberCount,
        score,
        matchedTerms,
        linkedToOtherPatient: linked.has(g.chatId),
        contiguousBonus,
      };
    })
    .filter(c => c.score > 0)
    // `score > 0` só acontece com chatName preenchido (ver scoreGroupName), então
    // `String(...)` aqui é conversão de tipo, não fallback de caso possível.
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.contiguousBonus) - Number(a.contiguousBonus) ||
        String(a.chatName).localeCompare(String(b.chatName)),
    )
    .slice(0, input.limit);
}

// ── DESEMPATE POR PAPEL ──────────────────────────────────────────────────────
//
// POR QUE EXISTE, com número. Rodando o ranqueamento acima contra o mapeamento
// manual do Marcel (238 pacientes, gabarito real): o grupo dos PRESTADORES vinha
// em 1º lugar em 91,8% dos casos, o da FAMÍLIA em só 52,4% — e os dois estavam
// no top 3 em 100% dos casos, com zero falhas em 253.
//
// A causa do 52,4% não é o score: é o EMPATE. "Flia. Perez Maria" e "Equipo
// Perez Maria" contêm exatamente os mesmos termos do nome do paciente, então
// ficam com o MESMO score, e o desempate era `localeCompare` do nome do grupo —
// que põe "Equipo" antes de "Flia" sempre. Era alfabeto decidindo papel.
//
// As palavras que distinguem ("flia" × "equipo") são justamente as que a
// STOPWORDS acima descarta — de propósito, porque elas não distinguem PACIENTE.
// Agora que o papel existe como conceito, elas voltam a servir, mas para outra
// pergunta: não "de quem é este grupo?", e sim "de qual PAPEL ele é?".
//
// ⚠️ INVARIANTE DELIBERADA: a afinidade só desempata score IGUAL. Ela nunca
// reordena candidatos de scores diferentes. É o que garante, por construção,
// que os 100% de "está no top 3" não podem piorar: a multiset de scores em cada
// posição não muda. Uma afinidade que somasse ao score poderia empurrar um grupo
// de "flia" alheio para cima do grupo certo do paciente — trocaria um acerto
// medido por uma esperança.

/** Uma linha do catálogo, no recorte que o desempate usa. */
export interface RoleMatchSpec {
  code: string;
  /** `match_keywords` do catálogo, já normalizadas (minúsculas, sem acento). */
  matchKeywords: readonly string[];
}

/** Um termo do nome do grupo bate com alguma palavra do papel? */
function nameMatchesKeywords(chatName: string | null, keywords: readonly string[]): boolean {
  if (!chatName || keywords.length === 0) return false;
  const terms = new Set(normalizeForMatch(chatName).split(' ').filter(Boolean));
  return keywords.some(k => terms.has(k));
}

/**
 * Afinidade de um grupo com um papel: 1 (o nome tem palavra DESTE papel),
 * -1 (tem palavra de OUTRO papel e nenhuma deste) ou 0 (não diz nada).
 *
 * O -1 é o que resolve o caso real: sem ele, o grupo "Equipo Perez" ficaria
 * empatado em 0 com um grupo de nome neutro na disputa pelo papel FAMILY, e o
 * alfabeto voltaria a decidir. Com ele, o grupo que se declara de outro papel
 * desce — sem nunca sair do top 3, porque o score não mudou.
 */
export function roleAffinity(
  chatName: string | null,
  role: RoleMatchSpec,
  otherRoles: readonly RoleMatchSpec[],
): -1 | 0 | 1 {
  if (nameMatchesKeywords(chatName, role.matchKeywords)) return 1;
  const claimedByOther = otherRoles.some(
    other => other.code !== role.code && nameMatchesKeywords(chatName, other.matchKeywords),
  );
  return claimedByOther ? -1 : 0;
}

/**
 * Reordena candidatos JÁ ranqueados para um papel específico.
 *
 * Não recalcula score nenhum: só troca o critério de desempate, de "ordem
 * alfabética do nome do grupo" para "quem se declara deste papel primeiro, quem
 * se declara de outro por último". Fora do empate, a ordem é a mesma.
 */
export function orderCandidatesForRole(
  candidates: readonly ChatCandidate[],
  role: RoleMatchSpec,
  allRoles: readonly RoleMatchSpec[],
): ChatCandidate[] {
  const others = allRoles.filter(r => r.code !== role.code);
  const affinity = new Map(candidates.map(c => [c.chatId, roleAffinity(c.chatName, role, others)]));

  return [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      (affinity.get(b.chatId) ?? 0) - (affinity.get(a.chatId) ?? 0) ||
      String(a.chatName).localeCompare(String(b.chatName)),
  );
}
