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
 * Retorna `score` (0..1) e os termos que bateram.
 */
export function scoreGroupName(
  patientTerms: string[],
  groupName: string | null,
): { score: number; matchedTerms: string[] } {
  if (patientTerms.length === 0 || !groupName) return { score: 0, matchedTerms: [] };

  const groupTerms = normalizeForMatch(groupName).split(' ').filter(Boolean);
  if (groupTerms.length === 0) return { score: 0, matchedTerms: [] };

  const matchedTerms = patientTerms.filter(t => matchesTerm(t, groupTerms));
  if (matchedTerms.length === 0) return { score: 0, matchedTerms: [] };

  const base = matchedTerms.length / patientTerms.length;

  // Bônus de nome inteiro contíguo: "Maria Perez" dentro de "Flia Maria Perez"
  // é sinal mais forte que os mesmos dois termos espalhados. Nunca passa de 1.
  const contiguous = normalizeForMatch(patientTerms.join(' '));
  const bonus = normalizeForMatch(groupName).includes(contiguous) ? 0.25 : 0;

  return { score: Math.min(1, Number((base + bonus).toFixed(4))), matchedTerms };
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
 * Empate resolvido por nome do grupo (ordem estável e reproduzível), nunca pela
 * ordem em que o Periskope devolveu.
 */
export function rankChatCandidates(input: RankChatCandidatesInput): ChatCandidate[] {
  const patientTerms = toMatchTerms(input.patientName);
  const linked = input.linkedElsewhere ?? new Set<string>();

  return input.groups
    .map(g => {
      const { score, matchedTerms } = scoreGroupName(patientTerms, g.chatName);
      return {
        chatId: g.chatId,
        chatName: g.chatName,
        memberCount: g.memberCount,
        score,
        matchedTerms,
        linkedToOtherPatient: linked.has(g.chatId),
      };
    })
    .filter(c => c.score > 0)
    // `score > 0` só acontece com chatName preenchido (ver scoreGroupName), então
    // `String(...)` aqui é conversão de tipo, não fallback de caso possível.
    .sort((a, b) => b.score - a.score || String(a.chatName).localeCompare(String(b.chatName)))
    .slice(0, input.limit);
}
