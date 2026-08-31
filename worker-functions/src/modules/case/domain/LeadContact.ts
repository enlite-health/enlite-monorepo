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
 * Máscara de e-mail: mora em `shared/utils/emailMask` — política ÚNICA do
 * produto (o gate de 31/08 pegou esta função duplicando a do
 * `AccountLinkService`, com saída divergente). Re-exportada aqui porque o
 * repositório de pacientes consome deste módulo.
 *
 * A finalidade declarada continua sendo DESEMPATAR cards, e desempatar não
 * exige o endereço inteiro (lex C1 — LGPD art. 6º III; Ley 25.326 art. 4º inc.
 * 1). Roda no SERVIDOR: máscara feita no cliente é teatro.
 */
export { maskEmail } from '@shared/utils/emailMask';
