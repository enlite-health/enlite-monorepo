import { AxiosInstance } from 'axios';
import { logger, reportError } from '@shared/logging';
import { createPeriskopeHttpClient } from './periskopeHttpClient';

/** Um grupo de WhatsApp visto pelo Periskope. `chatId` sempre termina em `@g.us`. */
export interface PeriskopeGroupChat {
  chatId: string;
  chatName: string | null;
  memberCount: number | null;
  /**
   * De QUAL número conectado este grupo veio (`5491176360496@c.us`).
   *
   * A leitura é da org inteira (ver `scopeToPhone: false`), então um grupo pode
   * vir de qualquer número. Sobe até a tela porque responde sozinha a pergunta
   * que a operação faz quando um grupo não aparece: **"o nosso número está
   * nesse grupo?"** — um grupo em que nenhum número nosso entrou simplesmente
   * não existe para nós, e isso é membresia de WhatsApp, não bug de software.
   *
   * `null` quando a API não informa (contrato defensivo, não caso esperado).
   */
  orgPhone: string | null;
}

export interface GroupChatsResult {
  groups: PeriskopeGroupChat[];
  /**
   * `true` = a lista está INCOMPLETA (a varredura parou no limite de segurança).
   *
   * Isso NÃO é um detalhe de log: quem está vinculando precisa saber, senão lê
   * "não achei nenhum grupo" quando a verdade é "a lista foi cortada antes de
   * chegar no dele". Por isso viaja no resultado, sobe pela API e aparece na
   * tela — a regra da casa é alarme determinístico, não `logger.warn` que
   * ninguém lê.
   */
  truncated: boolean;
}

/** Tamanho de página do `GET /chats`. Verificado contra produção: `offset` pagina de verdade. */
const PAGE_SIZE = 200;

/**
 * Guarda contra laço infinito se a API passar a ignorar `offset` (a varredura
 * pararia de avançar). 50 páginas = 10.000 grupos, ~13× a org de hoje (774).
 * Bater aqui não silencia nada: o resultado sai com `truncated: true`.
 */
const MAX_PAGES = 50;

/** TTL default do cache da lista de grupos. */
const DEFAULT_CACHE_TTL_MS = 120_000;

interface PeriskopeChatsResponse {
  chats?: Array<{
    chat_id?: string;
    chat_name?: string | null;
    member_count?: number | null;
    org_phone?: string | null;
  }>;
}

interface CacheEntry {
  result: GroupChatsResult;
  expiresAt: number;
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
 * PAGINA até o fim (não há teto de resultados): a org tinha 774 grupos em
 * 08/08/2026 e cresce. Antes havia um corte fixo em 1.000 com um `logger.warn`
 * — degradação silenciosa: o grupo de um paciente podia cair fora do corte e a
 * tela diria "nenhum candidato".
 *
 * CACHEIA o resultado por alguns minutos. Um backfill de ~350 pacientes faria
 * ~350 varreduras completas da mesma lista; com cache é uma só por janela, o
 * que também tira o risco de bater rate limit justamente no dia do backfill.
 *
 * Best-effort por contrato: nunca lança. Falha (não configurado, rede, HTTP)
 * vira `null`, e o caller distingue "não deu para consultar" de "consultei e
 * não achei nada" (que é `{ groups: [], truncated: false }`).
 *
 * Nunca loga nome de grupo nem de paciente — nome de grupo carrega nome de
 * paciente (PII sob a Ley 25.326). Só contagens.
 */
export class PeriskopeChatReadService {
  private readonly http: AxiosInstance | null;
  private readonly cacheTtlMs: number;
  private cache: CacheEntry | null = null;

  constructor(http?: AxiosInstance | null, cacheTtlMs?: number) {
    // `scopeToPhone: false` — a org tem MAIS DE UM número conectado, e um grupo
    // vinculável pode estar em qualquer um deles. Com o escopo ligado
    // enxergávamos 774 de 788 grupos, e os 14 que faltavam não apareciam como
    // erro nenhum: a tela diria "nenhum candidato" para quem tem grupo lá.
    // Ler é da ORG; enviar é DE UM NÚMERO — por isso só os serviços de envio
    // continuam escopados.
    this.http = http !== undefined ? http : createPeriskopeHttpClient(15000, { scopeToPhone: false });
    this.cacheTtlMs = cacheTtlMs ?? readCacheTtlFromEnv();
    if (!this.http) {
      logger.warn({ msg: '[PeriskopeChatReadService] Not configured — chat lookup disabled' });
    }
  }

  get isConfigured(): boolean {
    return this.http !== null;
  }

  /** Descarta o cache. Usado quando o operador quer forçar releitura. */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Todos os grupos (`@g.us`) da org, paginando até o fim.
   * `null` = não deu para consultar.
   */
  async listGroupChats(opts: { forceRefresh?: boolean } = {}): Promise<GroupChatsResult | null> {
    if (!this.http) return null;

    if (!opts.forceRefresh) {
      const cached = this.readCache();
      if (cached) return cached;
    }

    try {
      const groups: PeriskopeGroupChat[] = [];
      const seen = new Set<string>();
      let truncated = true; // pessimista: só vira false quando a varredura termina sozinha

      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await this.http.get<PeriskopeChatsResponse>('/chats', {
          params: { chat_type: 'group', limit: PAGE_SIZE, offset: page * PAGE_SIZE },
        });
        const raw = res.data?.chats ?? [];

        for (const chat of raw) {
          // O filtro do servidor já devolve só grupos; o `endsWith` é a trava
          // nossa, igual à do PeriskopeGroupNotifyService: um `@c.us` aqui é
          // bug, não feature. `seen` protege de repetição entre páginas.
          if (typeof chat.chat_id !== 'string' || !chat.chat_id.endsWith('@g.us')) continue;
          if (seen.has(chat.chat_id)) continue;
          seen.add(chat.chat_id);
          groups.push({
            chatId: chat.chat_id,
            chatName: chat.chat_name ?? null,
            memberCount: typeof chat.member_count === 'number' ? chat.member_count : null,
            orgPhone: typeof chat.org_phone === 'string' ? chat.org_phone : null,
          });
        }

        // Página incompleta = acabou a lista. É a única saída "limpa".
        if (raw.length < PAGE_SIZE) {
          truncated = false;
          break;
        }
      }

      if (truncated) {
        logger.warn(
          { collected: groups.length, maxPages: MAX_PAGES, pageSize: PAGE_SIZE },
          '[PeriskopeChatReadService] varredura parou no limite de páginas — lista incompleta',
        );
      }

      const result: GroupChatsResult = { groups, truncated };
      // Lista incompleta não entra no cache: seria congelar um resultado ruim.
      if (!truncated) this.writeCache(result);
      return result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn({ error: e.message }, '[PeriskopeChatReadService] listGroupChats failed');
      reportError(e, { source: 'PeriskopeChatReadService:listGroupChats' });
      return null;
    }
  }

  private readCache(): GroupChatsResult | null {
    if (!this.cache) return null;
    if (Date.now() >= this.cache.expiresAt) {
      this.cache = null;
      return null;
    }
    return this.cache.result;
  }

  private writeCache(result: GroupChatsResult): void {
    if (this.cacheTtlMs <= 0) return; // TTL 0 desliga o cache (útil em teste)
    this.cache = { result, expiresAt: Date.now() + this.cacheTtlMs };
  }
}

/** `PERISKOPE_CHATS_CACHE_TTL_MS`; valor inválido ou ausente cai no default. */
function readCacheTtlFromEnv(): number {
  const raw = Number.parseInt(process.env.PERISKOPE_CHATS_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}
