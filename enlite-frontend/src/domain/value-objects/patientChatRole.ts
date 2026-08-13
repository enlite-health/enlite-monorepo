/**
 * Papéis de grupo de WhatsApp (Periskope) do paciente.
 *
 * ⚠️ NÃO EXISTE MAIS LISTA AQUI. O catálogo vive na tabela `patient_chat_roles`
 * (migration 262) e chega pela API (`GET /api/admin/patient-chat-roles`). Antes
 * ele estava escrito duas vezes — aqui e no backend — e as duas cópias
 * envelheciam junto com a operação: em um único dia o papel foi de 2 para 3,
 * com um quarto citado solto. Papel novo passou a ser um clique na tela
 * `/admin/patient-chat-roles`, sem deploy nem migration, e por isso o painel não
 * pode ter opinião própria sobre quais papéis existem.
 *
 * Os RÓTULOS também vêm do catálogo (es + pt-BR), não do `es.json`/`pt-BR.json`:
 * um papel criado pela administração não teria como ter chave de i18n.
 */

/** Uma linha do catálogo, como a API devolve. */
export interface PatientChatRoleSpec {
  code: string;
  labelEs: string;
  labelPtBr: string;
  /**
   * `true` = um grupo deste papel pertence a NO MÁXIMO um paciente. É a trava
   * que impede a auditoria de informes de contar a mesma conversa duas vezes.
   */
  isExclusive: boolean;
  displayOrder: number;
  isActive: boolean;
  /** Palavras que identificam o papel no NOME do grupo ("flia" × "equipo"). */
  matchKeywords: string[];
}

/** Papel -> chat_id do grupo. Papel ausente = não vinculado. */
export type PatientChatIdMap = Partial<Record<string, string>>;

/**
 * Os papéis a EXIBIR para um paciente: os do catálogo, na ordem dele, mais
 * qualquer papel que o paciente já tenha gravado e que o catálogo não traga
 * (papel desativado depois de vinculado, ou catálogo que não carregou).
 *
 * Esconder um vínculo existente é pior que mostrar um código cru: a pessoa que
 * abre a ficha precisa ver que aquele grupo está lá, mesmo que o papel tenha
 * saído do catálogo — senão ela vincula outro por cima sem saber.
 */
export function chatRolesToDisplay(
  catalog: readonly PatientChatRoleSpec[],
  chatIds: PatientChatIdMap | null | undefined,
): string[] {
  const known = catalog.map(r => r.code);
  const extras = Object.keys(chatIds ?? {}).filter(role => !known.includes(role));
  return [...known, ...extras.sort()];
}

/**
 * Rótulo do papel no idioma da tela. Papel fora do catálogo cai no próprio
 * código — nunca em string vazia, que apareceria como um campo sem nome.
 */
export function chatRoleLabel(
  catalog: readonly PatientChatRoleSpec[],
  code: string,
  locale: string,
): string {
  const spec = catalog.find(r => r.code === code);
  if (!spec) return code;
  return locale.toLowerCase().startsWith('pt') ? spec.labelPtBr : spec.labelEs;
}

/**
 * Forma exigida de um código de papel — espelha os CHECKs do banco
 * (`patient_chat_ids_role_shape` e `patient_chat_roles_code_shape`) e o schema
 * Zod do backend. Validar na tela é só para dar erro ANTES do round-trip; a
 * garantia é do banco.
 */
export const PATIENT_CHAT_ROLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Comprimento da coluna `patient_chat_roles.code`. */
export const PATIENT_CHAT_ROLE_MAX_LENGTH = 32;

export function isPatientChatRoleCode(value: string): boolean {
  return value.length <= PATIENT_CHAT_ROLE_MAX_LENGTH && PATIENT_CHAT_ROLE_PATTERN.test(value);
}
