/**
 * Destino do login por área (design §6, F4).
 *
 *  - `next` só é respeitado se a pessoa abre a área dele (senão é ignorado e vale o destino por área);
 *  - 0 áreas → `/no-access`; áreas, mas nenhuma navegável → `/no-access?reason=unavailable`; 1 → o `entryRoute`; > 1 → a última usada (`localStorage`,
 *    chave por uid, com `try/catch`) ou a primeira da ordem estável que o servidor devolve;
 *  - `next` sob `/admin` chama o perfil admin ANTES (é ele que provisiona o staff novo) [AJUSTE A7];
 *  - `tokenRefreshRequired` → `getIdToken(true)` antes de navegar;
 *  - devolve só um caminho: quem navega, navega UMA vez (sem laço de redirect).
 */
import { useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AreasApiService } from '@infrastructure/http/AreasApiService';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { AreaEntry } from '@domain/entities/MyAreas';

export const NO_ACCESS_ROUTE = '/no-access';
/** Tem vínculo, mas só a áreas sem tela ainda (`entryRoute` nulo): a página diz "ainda não disponível". */
export const NO_ACCESS_UNAVAILABLE_ROUTE = '/no-access?reason=unavailable';
const LAST_AREA_KEY_PREFIX = 'enlite.lastArea.';
/** Áreas que NÃO são a raiz: o caminho sob esse prefixo é só delas, mesmo que a pessoa abra `/`. */
const NON_ROOT_PREFIXES = ['/admin'];

const authService = new FirebaseAuthService();

export const areaKey = (e: Pick<AreaEntry, 'area' | 'role'>): string => `${e.area}:${e.role}`;

export function readLastArea(uid: string): string | null {
  try {
    return localStorage.getItem(LAST_AREA_KEY_PREFIX + uid);
  } catch {
    return null;
  }
}

export function writeLastArea(uid: string, key: string): void {
  try {
    localStorage.setItem(LAST_AREA_KEY_PREFIX + uid, key);
  } catch {
    // storage indisponível (janela privada, bloqueio): a memória é só conveniência.
  }
}

/** Só caminho interno (`/x`); `//host`, URL absoluta e `\` ficam de fora (open redirect). */
function isInternalPath(next: string | null): next is string {
  return !!next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\');
}

function pathOf(next: string): string {
  return next.split(/[?#]/)[0];
}

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function isAdminPath(next: string | null): boolean {
  return isInternalPath(next) && isUnder(pathOf(next), '/admin');
}

/** A pessoa abre a área dona de `next`? A dona é a de prefixo próprio; sem prefixo, a raiz (`/`). */
export function nextIsOpenTo(next: string, navigable: AreaEntry[]): boolean {
  const entries = navigable.map((a) => a.entryRoute);
  const prefixes = [...new Set([...NON_ROOT_PREFIXES, ...entries.filter((e): e is string => !!e && e !== '/')])];
  const path = pathOf(next);
  const owner = prefixes.find((p) => isUnder(path, p));
  return owner ? entries.includes(owner) : entries.includes('/');
}

export function useAreaDestination() {
  const resolveDestination = useCallback(async (rawNext: string | null): Promise<string> => {
    const next = isInternalPath(rawNext) ? rawNext : null;

    if (isAdminPath(next)) {
      // Provisiona o staff novo. Falha (ex.: prestador, 403) não impede: as áreas decidem.
      try {
        await AdminApiService.getProfile();
      } catch {
        /* segue para as áreas */
      }
    }

    const { areas, tokenRefreshRequired } = await AreasApiService.getMyAreas();
    if (tokenRefreshRequired) {
      try {
        await authService.forceRefreshToken();
      } catch {
        /* o token antigo segue válido; o claim novo chega no próximo refresh natural */
      }
    }

    const navigable = areas.filter((a) => a.entryRoute != null);
    if (navigable.length === 0) return areas.length > 0 ? NO_ACCESS_UNAVAILABLE_ROUTE : NO_ACCESS_ROUTE;
    if (next && nextIsOpenTo(next, navigable)) return next;

    const uid = (await authService.getCurrentUser().catch(() => null))?.id ?? null;
    const last = uid && navigable.length > 1 ? readLastArea(uid) : null;
    const chosen = navigable.find((a) => areaKey(a) === last) ?? navigable[0];
    if (uid) writeLastArea(uid, areaKey(chosen));
    return chosen.entryRoute as string;
  }, []);

  return { resolveDestination };
}
