/**
 * Iniciais para avatar — MESMO algoritmo até então duplicado em `WorkerAvatar.tsx` e
 * `MessageAvatar.tsx` (achado A6 do gate 21/09, spec 022 ajustes de UI): 1ª letra das até 2
 * PRIMEIRAS palavras do nome (em ordem, nunca primeira+última), maiúscula, `'?'` para nome
 * vazio/nulo/só espaços.
 *
 * `InviteProgressPanel.tsx` tem uma função de nome parecido (`initials`) mas com ALGORITMO
 * DIFERENTE (primeira+última palavra para nome com 3+ partes, 2 primeiros caracteres para
 * palavra única, `'—'` de fallback) — não é o mesmo conceito, então não foi unificada aqui:
 * unificar mudaria o texto exibido em telas fora do escopo deste ajuste (VacancyMatch), sem
 * autorização nomeada para essa mudança de comportamento.
 */
export function getInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}
