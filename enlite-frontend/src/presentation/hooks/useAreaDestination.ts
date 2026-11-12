/**
 * Destino do login por área (design §6, F4).
 *
 *  - `next` só é respeitado se a pessoa abre a área dele; senão → `/no-access` (design §6: sem laço, sem cair em silêncio noutra área);
 *  - 0 áreas → `/no-access`; áreas, mas nenhuma navegável → `/no-access?reason=unavailable`; 1 → o `entryRoute`; > 1 → a última usada (`localStorage`,
 *    chave por uid, com `try/catch`) ou a primeira da ordem estável que o servidor devolve;
 *  - `next` sob `/admin` chama o perfil admin ANTES (é ele que provisiona o staff novo) [AJUSTE A7];
 *  - lista VAZIA (e `next` fora de `/admin`) é o 1º login: o perfil provisiona o staff `@enlite.health` novo; quem não é staff
 *    passa pelo `initWorker` (autocadastro, ou religa por e-mail a ficha importada — H2: identidade só do token) e as áreas
 *    são relidas. Só aqui há init: staff, aluno e prestador já vinculado nunca ganham ficha no login;
 *  - `tokenRefreshRequired` → `getIdToken(true)` antes de navegar;
 *  - devolve só um caminho: quem navega, navega UMA vez (sem laço de redirect).
 */
import { useCallback } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AreasApiService } from '@infrastructure/http/AreasApiService';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
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

/**
 * 1º login de quem não tem área nenhuma. `true` = algo foi provisionado e as áreas devem ser relidas.
 * Perfil antes do init: o staff `@enlite.health` ainda sem linha em `users` também chega aqui com a lista vazia, e o init
 * lhe daria uma ficha de prestador. Perfil que falha (403: não é staff) → o init, como o autocadastro de sempre.
 */
async function provisionFirstLogin(): Promise<boolean> {
  try {
    await AdminApiService.getProfile();
    return true;
  } catch {
    /* não é staff: segue para o prestador */
  }
  const user = await authService.getCurrentUser().catch(() => null);
  if (!user) return false;
  try {
    await WorkerApiService.initWorker({ authUid: user.id, email: user.email });
    return true;
  } catch {
    return false;
  }
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

    let { areas, tokenRefreshRequired } = await AreasApiService.getMyAreas();
    if (areas.length === 0 && !isAdminPath(next)) {
      if (!(await provisionFirstLogin())) return NO_ACCESS_ROUTE;
      const reread = await AreasApiService.getMyAreas();
      areas = reread.areas;
      tokenRefreshRequired = tokenRefreshRequired || reread.tokenRefreshRequired;
    }
    if (tokenRefreshRequired) {
      try {
        await authService.forceRefreshToken();
      } catch {
        /* o token antigo segue válido; o claim novo chega no próximo refresh natural */
      }
    }

    const navigable = areas.filter((a) => a.entryRoute != null);
    if (navigable.length === 0) return areas.length > 0 ? NO_ACCESS_UNAVAILABLE_ROUTE : NO_ACCESS_ROUTE;
    // `next` de área que a pessoa não abre → /no-access (design §6, "sem laço"): nunca ao login e nunca em silêncio na outra área.
    if (next) return nextIsOpenTo(next, navigable) ? next : NO_ACCESS_ROUTE;

    const uid = (await authService.getCurrentUser().catch(() => null))?.id ?? null;
    const last = uid && navigable.length > 1 ? readLastArea(uid) : null;
    const chosen = navigable.find((a) => areaKey(a) === last) ?? navigable[0];
    if (uid) writeLastArea(uid, areaKey(chosen));
    return chosen.entryRoute as string;
  }, []);

  return { resolveDestination };
}
