/**
 * AnaCareEnliteDirectory — descobre quais contas/reservas do Ana Care são da Enlite.
 *
 * A API REST não tem filtro por agência (`?agency=` é ignorado em silêncio — ver
 * `AnaCareSessionClient`). A única superfície que responde "isto é da Enlite?" é o painel HTML
 * do admin, que já vem escopado por agência:
 *   - `/admin/accounts/` — serviços ATIVOS (medido 17/09: 211 contas). PAGINADO desde algum momento
 *     entre 15/10 e 04/11 (25 por página, `?tab=clients&page=N`; medido 04/11: 217 em 9 páginas)
 *   - `/admin/accounts/terminated_services` — serviços TERMINADOS (medido 17/09: 72 contas, sem
 *     sobreposição com os ativos — união medida: 283)
 *
 * Conta e reserva são o MESMO número (verificado 100/100 na medição de 17/09) — por isso a saída
 * é `reservationId`.
 *
 * Reaproveita a MESMA sessão do `AnaCareSessionClient` (login, cookie, rate limiter, re-login em
 * 403/302) via `requestText` — nenhum mecanismo de sessão paralelo é criado aqui.
 */

import type { AnaCareSessionClient } from './AnaCareSessionClient';
import { logger } from '@shared/logging';

const ACTIVE_PATH = '/admin/accounts/';
const TERMINATED_PATH = '/admin/accounts/terminated_services';

/**
 * Teto de páginas de ATIVOS (medido 04/11: 9 páginas). ⚠️ O Ana Care NÃO devolve 404 nem lista vazia
 * além do fim: a página 10, 11, 99 repete a última. Por isso o fim é detectado por "nenhum id novo",
 * e o teto é só trava de segurança — atingi-lo com ids ainda novos é FALHA, nunca diretório truncado.
 */
const MAX_ACTIVE_PAGES = 50;

/** IDs de conta/reserva aparecem no HTML como `/accounts/<dígitos>/`. */
const ACCOUNT_ID_RE = /\/accounts\/(\d+)\//g;

export interface EnliteDirectoryEntry {
  reservationId: string;
  origin: 'activo' | 'terminado';
}

export interface EnliteDirectory {
  entries: EnliteDirectoryEntry[];
  counts: { activo: number; terminado: number; total: number };
  /** `true` quando a página de TERMINADOS não pôde ser lida — `entries`/`counts` refletem só os ATIVOS. */
  partial: boolean;
}

/** Erro nomeado para distinguir "raspagem quebrada" de qualquer outro `Error` genérico. */
export class AnaCareEnliteDirectoryError extends Error {}

/**
 * Extrai ids distintos de conta/reserva do HTML.
 *
 * ⚠️ Contagem zero é FALHA, nunca sucesso — a raspagem quebra em SILÊNCIO se o template do Ana
 * Care mudar (menos linhas casadas, nenhum erro de rede). Por isso esta função LANÇA quando não
 * encontra nenhum id, em vez de devolver lista vazia — devolver `[]` aqui esconderia a quebra do
 * chamador, que só veria "zero contas" e não teria como distinguir de um estado real vazio.
 */
function extractAccountIds(html: string, pageLabel: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(ACCOUNT_ID_RE)) {
    ids.add(match[1]);
  }
  if (ids.size === 0) {
    throw new AnaCareEnliteDirectoryError(
      `[AnaCareEnliteDirectory] página "${pageLabel}": zero contas extraídas do HTML — raspagem ` +
        'provavelmente quebrada (template mudou), não tratar como "sem contas".',
    );
  }
  return Array.from(ids);
}

export class AnaCareEnliteDirectory {
  constructor(private readonly client: AnaCareSessionClient) {}

  /**
   * Percorre `?tab=clients&page=N` a partir da 1, acumulando ids distintos. Para quando uma página
   * não traz nenhum id novo (fim real: o Ana Care repete a última) ou lança ao bater o teto.
   * Página 1 sem conta = falha (`extractAccountIds`); páginas seguintes sem id novo = fim.
   */
  private async fetchActiveIds(): Promise<string[]> {
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_ACTIVE_PAGES; page += 1) {
      const html = await this.client.requestText(ACTIVE_PATH, { tab: 'clients', page });
      const before = seen.size;
      if (page === 1) {
        for (const id of extractAccountIds(html, 'ativos')) seen.add(id);
      } else {
        for (const match of html.matchAll(ACCOUNT_ID_RE)) seen.add(match[1]);
        if (seen.size === before) return Array.from(seen);
      }
    }
    throw new AnaCareEnliteDirectoryError(
      `[AnaCareEnliteDirectory] ativos: ${MAX_ACTIVE_PAGES} páginas lidas e ainda chegam ids novos — ` +
        'paginação fora do esperado, diretório truncado não é devolvido.',
    );
  }

  /**
   * Lê as duas páginas do painel e devolve os ids distintos, por origem.
   *
   * A página de ATIVOS é a base do cálculo — se ela falhar (rede ou raspagem quebrada), o erro
   * sobe e nada é devolvido: não existe diretório útil sem o conjunto maior. Se só a página de
   * TERMINADOS falhar, os ATIVOS não são descartados: o retorno marca `partial: true` para quem
   * chama saber que a parte de terminados está ausente, em vez de ler silenciosamente um
   * diretório incompleto como se fosse completo.
   */
  async fetch(): Promise<EnliteDirectory> {
    const activeIds = await this.fetchActiveIds();

    let terminatedIds: string[] = [];
    let partial = false;
    try {
      const terminatedHtml = await this.client.requestText(TERMINATED_PATH);
      terminatedIds = extractAccountIds(terminatedHtml, 'terminados');
    } catch (err) {
      // Nunca silencioso: a causa técnica (mensagem + status HTTP, sem corpo/PII) vai para o log.
      logger.warn({
        msg: '[AnaCareEnliteDirectory] página de terminados falhou — diretório marcado partial',
        error: err instanceof Error ? err.message : String(err),
        status: (err as { status?: number } | null)?.status,
      });
      partial = true;
      terminatedIds = [];
    }

    const entries: EnliteDirectoryEntry[] = [
      ...activeIds.map((reservationId): EnliteDirectoryEntry => ({ reservationId, origin: 'activo' })),
      ...terminatedIds.map((reservationId): EnliteDirectoryEntry => ({ reservationId, origin: 'terminado' })),
    ];

    const total = new Set(entries.map((e) => e.reservationId)).size;

    return {
      entries,
      counts: { activo: activeIds.length, terminado: terminatedIds.length, total },
      partial,
    };
  }
}
