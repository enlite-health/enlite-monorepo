/**
 * LeadContact — identidade mínima do lead vindo do formulário público.
 *
 * O formulário de `/admision` não colhe nome (decisão de produto 27/07,
 * `2026-07-27a#DEC-02`), então o `CreateLeadUseCase` grava um placeholder
 * literal. O efeito na tela é que TODO lead vira um card escrito "Solicitante",
 * e o Kanban fica com N caixas idênticas — indistinguíveis para quem precisa
 * ligar dentro do SLA de 24h (`PATIENT_SLA_THRESHOLDS_HOURS.SOLICITANTE`).
 *
 * Este módulo é DOMÍNIO de propósito: quem grava o placeholder (application) e
 * quem precisa reconhecê-lo para desempatar os cards (infrastructure) não podem
 * depender um do outro. A constante tem um dono só.
 */

/** Nome gravado quando o formulário público não colheu nome. */
export const LEAD_PLACEHOLDER_FIRST_NAME = 'Solicitante';

/**
 * true quando a ficha carrega o placeholder em vez de um nome real.
 *
 * Compara sem diferenciar caixa e ignora sobrenome vazio, porque é assim que o
 * `CreateLeadUseCase` grava (`lastName: null`) e é assim que o dado está nas
 * 10 linhas de produção. Ficha com nome real devolve false — e é isso que
 * mantém o contato do resto do board fora do payload.
 */
export function isLeadPlaceholderName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): boolean {
  if (lastName != null && lastName.trim() !== '') return false;
  return (firstName ?? '').trim().toLowerCase() === LEAD_PLACEHOLDER_FIRST_NAME.toLowerCase();
}

/**
 * Mascara um e-mail para exibição: `joana@gmail.com` → `jo***@gmail.com`.
 *
 * A finalidade declarada é DESEMPATAR cards, e desempatar não exige o endereço
 * inteiro (lex C1 — LGPD art. 6º III, necessidade; Ley 25.326 art. 4º inc. 1,
 * "no excesivos en relación al ámbito y finalidad"). Roda no SERVIDOR: máscara
 * feita no cliente é teatro, porque o valor cru continua no payload, no devtools
 * e em qualquer gravação de sessão.
 *
 * Devolve null para qualquer entrada que não seja um e-mail reconhecível — em
 * vez de ecoar a string, que poderia ser um valor inesperado do banco.
 */
export function maskEmail(email: string | null | undefined): string | null {
  const trimmed = (email ?? '').trim();
  const at = trimmed.lastIndexOf('@');
  // Precisa de ao menos 1 char antes do @ e um domínio com ponto depois dele.
  if (at < 1 || !trimmed.slice(at + 1).includes('.')) return null;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const keep = local.length >= 2 ? 2 : 1;
  return `${local.slice(0, keep)}***${domain}`;
}
