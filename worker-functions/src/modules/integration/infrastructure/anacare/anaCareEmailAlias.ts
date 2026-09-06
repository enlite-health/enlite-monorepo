/**
 * Cálculo puro (sem I/O) do ALIAS de e-mail usado quando o Ana Care recusa o
 * endereço real do prestador. Extraído para ser testável isoladamente, mesmo
 * padrão de anaCareMirrorHealthMath.ts.
 *
 * POR QUE ALIAS, e não um e-mail inventado: `fulano+1@gmail.com` é entregue na
 * MESMA caixa que `fulano@gmail.com` — o prestador continua recebendo o que o
 * Ana Care mandar. Um endereço fabricado (`prestador123@enlite.health`) criaria
 * o cadastro e quebraria o contato em silêncio.
 *
 * ⚠️ Nem todo provedor implementa sub-endereçamento. Gmail sim; domínios
 * próprios e alguns provedores podem recusar ou não entregar. A decisão de
 * aplicar mesmo assim é do Gabriel (18/08/2026): o cadastro existir vale mais
 * que o e-mail funcionar, porque sem cadastro a pessoa não entra em caso
 * nenhum. O endereço usado fica gravado em `workers.ana_care_email_alias`
 * justamente para a coordenação conseguir tratar caso a caso.
 */

/** Quantos aliases tentar antes de desistir (+1, +2, +3). */
export const MAX_EMAIL_ALIAS_ATTEMPTS = 3;

/**
 * `fulano@gmail.com` + 1 → `fulano+1@gmail.com`.
 *
 * Usa o ÚLTIMO `@` para separar (endereços válidos podem ter `@` na parte
 * local quando entre aspas) e preserva um `+tag` que já exista — o objetivo é
 * um endereço novo e entregável, não um endereço canônico.
 */
export function buildEmailAlias(email: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`buildEmailAlias: attempt deve ser inteiro >= 1, recebido ${attempt}`);
  }
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    throw new Error('buildEmailAlias: e-mail sem parte local ou sem domínio');
  }
  return `${email.slice(0, at)}+${attempt}@${email.slice(at + 1)}`;
}
