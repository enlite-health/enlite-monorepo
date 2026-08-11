/**
 * PatientChatRole — o papel de um grupo de WhatsApp do paciente.
 *
 * ⚠️ O CATÁLOGO NÃO VIVE AQUI. Ele vive na tabela `patient_chat_roles`
 * (migration 262) e é administrado pela tela `/admin/patient-chat-roles`, só por
 * admin. Este arquivo guarda só o que é REGRA e não muda com a operação: a forma
 * de um código de papel e como se lê a exclusividade de um catálogo carregado.
 *
 * POR QUE O CATÁLOGO SAIU DO CÓDIGO: em um único dia o papel foi de 2 (call de
 * 05/08 — "sempre um família e um prestador") para 3 (áudio do Marcel — plano de
 * saúde), com um quarto citado solto ("de gestão"); e a planilha dele trouxe 27
 * pagadores distintos. Papel em código = migration + deploy toda vez que a
 * operação muda de ideia, e ela muda toda semana.
 */

/** Uma linha do catálogo, como a aplicação a enxerga. */
export interface PatientChatRoleSpec {
  code: string;
  labelEs: string;
  labelPtBr: string;
  /**
   * `true` = um grupo deste papel pertence a NO MÁXIMO um paciente.
   *
   * É a trava que impede a auditoria de informes da Candela de contar a mesma
   * conversa duas vezes, e é o que devolve 409 quando alguém tenta vincular um
   * grupo já tomado. Vira índice único parcial no banco através da coluna
   * derivada `patient_chat_ids.is_exclusive` (migrations 261 e 262).
   */
  isExclusive: boolean;
  displayOrder: number;
  isActive: boolean;
  /**
   * Palavras que identificam este papel no NOME do grupo ("flia" × "equipo"),
   * normalizadas. Usadas SÓ para desempatar o ranqueamento de candidatos —
   * nunca para escolher sozinho (ver `rankChatCandidates`).
   */
  matchKeywords: string[];
}

/**
 * Forma exigida de um código de papel, espelhando os CHECKs
 * `patient_chat_ids_role_shape` (261) e `patient_chat_roles_code_shape` (262).
 * Enum do repo é INGLÊS MAIÚSCULO — a regra vale para o papel que um admin
 * criar pela tela também.
 */
export const PATIENT_CHAT_ROLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Comprimento das colunas `patient_chat_ids.role` / `patient_chat_roles.code`. */
export const PATIENT_CHAT_ROLE_MAX_LENGTH = 32;

/** True quando `value` tem a FORMA de um código de papel (não diz se existe). */
export function isPatientChatRoleCode(value: string): boolean {
  return value.length <= PATIENT_CHAT_ROLE_MAX_LENGTH && PATIENT_CHAT_ROLE_PATTERN.test(value);
}

/** Catálogo indexado por código — o formato que o resto da aplicação consome. */
export type PatientChatRoleCatalog = ReadonlyMap<string, PatientChatRoleSpec>;

export function toRoleCatalog(roles: readonly PatientChatRoleSpec[]): PatientChatRoleCatalog {
  return new Map(roles.map(r => [r.code, r]));
}

/**
 * ⚠️ PONTO ÚNICO QUE DECIDE A EXCLUSIVIDADE DE UM PAPEL ⚠️
 *
 * Tudo que precisa saber "este grupo pode ser de mais de um paciente?" passa
 * por aqui — a escrita do vínculo, a checagem de conflito que devolve 409, e a
 * coluna derivada que alimenta o índice parcial. Mudar a política de um papel é
 * mudar `is_exclusive` na tabela `patient_chat_roles`, pela tela; nada de código
 * muda junto.
 *
 * Papel DESCONHECIDO (fora do catálogo — uma linha gravada por uma versão
 * futura, ou à mão no psql) responde `true`: na dúvida, tranca. Aceitar um
 * vínculo indevido envenena a contagem da auditoria em silêncio; recusar um
 * vínculo legítimo aparece na hora como 409 na tela.
 */
export function isExclusiveChatRole(catalog: PatientChatRoleCatalog, role: string): boolean {
  return catalog.get(role)?.isExclusive ?? true;
}

/** Rótulo do papel na língua pedida, com o próprio código como último recurso. */
export function chatRoleLabel(spec: PatientChatRoleSpec | undefined, locale: string): string {
  if (!spec) return '';
  return locale.toLowerCase().startsWith('pt') ? spec.labelPtBr : spec.labelEs;
}
