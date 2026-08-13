/**
 * PatientChatId — o `chat_id` do grupo de WhatsApp (Periskope) preso a um
 * paciente, POR PAPEL (migration 261; a 260 tinha duas colunas fixas).
 *
 * O Periskope distingue GRUPO (`@g.us`) de conversa 1-1 (`@c.us`). Aqui só
 * grupo entra: a auditoria de informes da Candela conta mensagens de grupo, e
 * um `@c.us` gravado neste campo é bug, não feature. Mesma trava que existe em
 * PeriskopeGroupNotifyService.sendToGroup.
 *
 * Formatos reais observados na API de produção (774 grupos, 08/08/2026):
 *   '<13 dígitos>-<10 dígitos>@g.us'  (legado, "criador-timestamp")
 *   '<18 dígitos>@g.us'               (formato novo)
 * O padrão aceita os dois e nada além disso. Espelhado no CHECK da migration 261.
 *
 * O catálogo de PAPÉIS vive em `PatientChatRole.ts`.
 */
export const GROUP_CHAT_ID_PATTERN = /^[0-9]+(-[0-9]+)?@g\.us$/;

/** Comprimento da coluna `patient_chat_ids.chat_id`. */
export const CHAT_ID_MAX_LENGTH = 64;

/** True quando `value` é um chat_id de GRUPO do Periskope. */
export function isGroupChatId(value: string): boolean {
  return value.length <= CHAT_ID_MAX_LENGTH && GROUP_CHAT_ID_PATTERN.test(value);
}

/**
 * Os grupos de um paciente, indexados por papel. Papel ausente = não vinculado.
 *
 * A chave é `string` e não `PatientChatRole` de propósito: o banco aceita
 * qualquer papel que case com a FORMA, então uma linha gravada por uma versão
 * mais nova (ou à mão) tem de atravessar a leitura sem quebrar. Quem valida
 * contra o catálogo é a ESCRITA (schema Zod), não a leitura.
 */
export type PatientChatIdMap = Record<string, string>;

/**
 * O que a ESCRITA aceita: papel -> chat_id, ou `null` para DESVINCULAR.
 *
 * Papel AUSENTE fica inalterado — não é o mesmo que `null`. É o que permite uma
 * versão antiga do painel (que só conhece FAMILY e PROVIDERS) salvar sem apagar
 * o HEALTH_PLAN que ela nem sabe que existe.
 */
export type PatientChatIdWriteMap = Record<string, string | null>;

/**
 * Os dois campos do contrato ANTIGO (migration 260), derivados do mapa.
 *
 * @deprecated Existem só pela metade EXPAND do expand/contract: `GET
 * /patients/:id` é caminho quente e um bundle antigo do painel, em cache no
 * navegador de quem opera, lê `patient.familyChatId`. Sem o alias ele mostraria
 * "não vinculado" para um paciente vinculado — mentira em tela, que é pior que
 * erro. Some junto com a migration de contract (`migrations/pending/`).
 */
export function legacyChatIdAliases(chatIds: PatientChatIdMap): {
  familyChatId: string | null;
  providersChatId: string | null;
} {
  return {
    familyChatId: chatIds.FAMILY ?? null,
    providersChatId: chatIds.PROVIDERS ?? null,
  };
}
