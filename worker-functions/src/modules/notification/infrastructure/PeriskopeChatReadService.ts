import { AxiosInstance } from 'axios';
import { logger, reportError } from '@shared/logging';
import { createPeriskopeHttpClient } from './periskopeHttpClient';

/** Um grupo de WhatsApp visto pelo Periskope. `chatId` sempre termina em `@g.us`. */
export interface PeriskopeGroupChat {
  chatId: string;
  chatName: string | null;
  memberCount: number | null;
}

/**
 * Teto do fetch em uma tacada. Medido contra a API de produção em 08/08/2026:
 * a org tinha 774 grupos, e `limit=1000` devolveu todos em uma resposta (~2,4 MB).
 * Se um dia a org passar de MAX_GROUPS, o serviço LOGA um aviso em vez de
 * truncar em silêncio — o upgrade path é paginar por `from`/`to`, que a API já
 * devolve no envelope.
 */
const MAX_GROUPS = 1000;

interface PeriskopeChatsResponse {
  chats?: Array<{
    chat_id?: string;
    chat_name?: string | null;
    member_count?: number | null;
  }>;
}

/**
 * PeriskopeChatReadService — LEITURA PURA da lista de chats do Periskope.
 *
 * ⚠️ Este serviço NUNCA envia mensagem, nota ou ticket. O único endpoint que ele
 * conhece é `GET /chats`, e o único filtro é `chat_type=group`. Envio vive em
 * PeriskopeMessagingService / PeriskopeGroupNotifyService, que são outros
 * objetos de propósito — misturar leitura e escrita aqui seria abrir caminho
 * para uma tela administrativa disparar mensagem em grupo real sem querer.
 *
 * Best-effort por contrato: nunca lança. Falha (não configurado, rede, HTTP)
 * vira `null`, e o caller distingue "não deu para consultar" de "consultei e
 * não achou nada" (que é `[]`).
 *
 * Nunca loga nome de grupo nem de paciente — nome de grupo carrega nome de
 * paciente (PII sob a Ley 25.326). Só contagens.
 */
export class PeriskopeChatReadService {
  private readonly http: AxiosInstance | null;

  constructor(http?: AxiosInstance | null) {
    this.http = http !== undefined ? http : createPeriskopeHttpClient();
    if (!this.http) {
      logger.warn({ msg: '[PeriskopeChatReadService] Not configured — chat lookup disabled' });
    }
  }

  get isConfigured(): boolean {
    return this.http !== null;
  }

  /** Todos os grupos (`@g.us`) da org. `null` = não deu para consultar. */
  async listGroupChats(): Promise<PeriskopeGroupChat[] | null> {
    if (!this.http) return null;

    try {
      const res = await this.http.get<PeriskopeChatsResponse>('/chats', {
        params: { chat_type: 'group', limit: MAX_GROUPS },
      });

      const raw = res.data?.chats ?? [];
      if (raw.length >= MAX_GROUPS) {
        logger.warn(
          { returned: raw.length, limit: MAX_GROUPS },
          '[PeriskopeChatReadService] lista de grupos possivelmente truncada — paginar',
        );
      }

      // O filtro do servidor já devolve só grupos; o `endsWith` é a trava nossa,
      // igual à do PeriskopeGroupNotifyService: um `@c.us` aqui é bug, não feature.
      return raw
        .filter((c): c is { chat_id: string } & typeof c =>
          typeof c.chat_id === 'string' && c.chat_id.endsWith('@g.us'),
        )
        .map(c => ({
          chatId: c.chat_id,
          chatName: c.chat_name ?? null,
          memberCount: typeof c.member_count === 'number' ? c.member_count : null,
        }));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn({ error: e.message }, '[PeriskopeChatReadService] listGroupChats failed');
      reportError(e, { source: 'PeriskopeChatReadService:listGroupChats' });
      return null;
    }
  }
}
