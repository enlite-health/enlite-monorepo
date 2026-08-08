/**
 * Papéis de grupo de WhatsApp (Periskope) do paciente — espelho do catálogo do
 * backend (`worker-functions/src/modules/case/domain/PatientChatRole.ts`).
 *
 * ⚠️ POR QUE ESTÁ ESCRITO DUAS VEZES: o painel é um bundle estático, não importa
 * do backend. O que evita a divergência virar bug silencioso:
 *   - a ORDEM e a lista daqui só governam a TELA; quem valida é o backend, que
 *     devolve 400 para papel que não conhece;
 *   - a leitura NUNCA depende desta lista — o card e o drawer renderizam o que
 *     vier no `chatIds` do paciente, e um papel desconhecido aparece com o
 *     próprio código como rótulo em vez de sumir da tela (`chatRoleLabelKey`).
 *
 * Somar um papel: uma entrada aqui, uma no catálogo do backend, e os rótulos em
 * `es.json` + `pt-BR.json` (`admin.patients.detail.chatIdsCard.roles.<PAPEL>`).
 * Nenhuma migration.
 */
export const PATIENT_CHAT_ROLES = ['FAMILY', 'PROVIDERS', 'HEALTH_PLAN'] as const;

export type PatientChatRole = (typeof PATIENT_CHAT_ROLES)[number];

/** Papel -> chat_id do grupo. Papel ausente = não vinculado. */
export type PatientChatIdMap = Partial<Record<string, string>>;

/**
 * Os papéis a exibir para um paciente: os conhecidos, na ordem do catálogo, mais
 * qualquer papel que o backend já grave e o painel ainda não conheça (deploy
 * fora de ordem, papel novo). Sem isso a tela esconderia um vínculo existente —
 * e esconder é pior que mostrar um código cru.
 */
export function chatRolesToDisplay(chatIds: PatientChatIdMap | null | undefined): string[] {
  const known: string[] = [...PATIENT_CHAT_ROLES];
  const extras = Object.keys(chatIds ?? {}).filter(role => !known.includes(role));
  return [...known, ...extras.sort()];
}

/**
 * Chave de i18n do rótulo do papel. Papel sem tradução cai no próprio código
 * (via o `defaultValue` de quem chama), nunca em string vazia.
 */
export function chatRoleLabelKey(role: string): string {
  return `admin.patients.detail.chatIdsCard.roles.${role}`;
}
