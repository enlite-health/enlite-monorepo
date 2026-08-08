/**
 * PatientChatRole — o CATÁLOGO de papéis de grupo de WhatsApp do paciente.
 *
 * Cada paciente tem N grupos no Periskope, um por papel. Isto aqui é a única
 * fonte de verdade sobre quais papéis existem e qual deles é exclusivo.
 *
 * POR QUE NÃO É UM ENUM DO POSTGRES: `ALTER TYPE ... ADD VALUE` é migration, e o
 * requisito desta mudança (ClickUp 86ajy1jhz) é justamente que somar um papel
 * novo NÃO exija migration. No banco, `patient_chat_ids.role` é VARCHAR com
 * CHECK de FORMATO (`^[A-Z][A-Z0-9_]*$`) — a forma é travada, o vocabulário não.
 *
 * O QUE CUSTA SOMAR UM PAPEL, honestamente: uma entrada neste objeto e um rótulo
 * em `es.json` + `pt-BR.json`. Zero migration, zero mudança de schema, zero
 * alteração em repositório/serviço/rota. Não é configuração de runtime, e não
 * deveria ser: um papel sem rótulo em duas línguas apareceria na tela como um
 * código cru para quem opera.
 */

/** O que a aplicação precisa saber sobre um papel. */
export interface PatientChatRoleSpec {
  /**
   * `true` = este grupo pertence a NO MÁXIMO um paciente.
   *
   * É a trava que impede a auditoria de informes da Candela de contar a mesma
   * conversa duas vezes, e é o que devolve 409 quando alguém tenta vincular um
   * grupo já tomado. Vira índice único parcial no banco via a coluna
   * `patient_chat_ids.is_exclusive` (migration 261).
   */
  exclusive: boolean;
}

/**
 * ⚠️ PONTO ÚNICO DA DECISÃO DE UNICIDADE ⚠️
 *
 * PERGUNTA ABERTA AO MARCEL, feita em 08/08/2026 e ainda SEM RESPOSTA:
 *
 *   "O grupo do PLANO DE SAÚDE é um por paciente, ou um por plano, servindo
 *    vários pacientes?"
 *
 * Se for compartilhado, `HEALTH_PLAN.exclusive` vira `false` — e é SÓ ISSO que
 * muda no código todo. Nem schema, nem rota, nem tela.
 *
 * Junto com o deploy dessa virada é preciso alinhar as linhas já gravadas:
 *   UPDATE patient_chat_ids SET is_exclusive = FALSE WHERE role = 'HEALTH_PLAN';
 * (migration de DADOS, não de schema — o ceiling está documentado na 261).
 *
 * Até a resposta chegar, HEALTH_PLAN fica EXCLUSIVO: é o comportamento
 * conservador. Recusar um vínculo legítimo aparece na hora como 409 na tela;
 * aceitar um vínculo indevido envenena a contagem da auditoria em silêncio.
 *
 * FAMILY e PROVIDERS são exclusivos por necessidade comprovada — foi essa trava
 * que devolveu o 409 provado em produção em 08/08/2026.
 */
export const PATIENT_CHAT_ROLES = {
  FAMILY: { exclusive: true },
  PROVIDERS: { exclusive: true },
  HEALTH_PLAN: { exclusive: true },
} as const satisfies Record<string, PatientChatRoleSpec>;

export type PatientChatRole = keyof typeof PATIENT_CHAT_ROLES;

/** Os papéis conhecidos, na ordem em que a tela os mostra. */
export const PATIENT_CHAT_ROLE_VALUES = Object.keys(PATIENT_CHAT_ROLES) as PatientChatRole[];

/**
 * Forma exigida de um papel, espelhando o CHECK `patient_chat_ids_role_shape`.
 * Enum do repo é INGLÊS MAIÚSCULO — a regra vale para papel novo também.
 */
export const PATIENT_CHAT_ROLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Comprimento da coluna `patient_chat_ids.role`. */
export const PATIENT_CHAT_ROLE_MAX_LENGTH = 32;

/** True quando `value` é um papel do catálogo. */
export function isPatientChatRole(value: string): value is PatientChatRole {
  return Object.prototype.hasOwnProperty.call(PATIENT_CHAT_ROLES, value);
}

/**
 * Este papel exige que o grupo seja de um paciente só?
 *
 * Papel DESCONHECIDO (uma linha gravada por uma versão futura, ou à mão no
 * psql) responde `true`: na dúvida, tranca. Ver a nota de política acima.
 */
export function isExclusiveChatRole(role: string): boolean {
  return isPatientChatRole(role) ? PATIENT_CHAT_ROLES[role].exclusive : true;
}
