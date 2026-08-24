/**
 * Leitura das células do ator na request — a ponte entre o `PermissionMiddleware`
 * e a `projectWorkerFields` (F2/C3).
 *
 * Existe como função, e não como `req.permissionCells ?? null` espalhado, por
 * uma razão só: o `??` inline convida a escrever `?? []`, e `[]` significa
 * "ator sem nenhuma célula" — o que redigiria o nome de TODO MUNDO enquanto o
 * engine ainda está desligado, quebrando o Kanban antes do flip. O nome desta
 * função é o lembrete de que os dois estados são diferentes.
 */

import type { Request } from 'express';

/**
 * `string[]` quando o engine decidiu nesta request; `null` quando não decidiu
 * (família fora de `PERMISSION_ENFORCED_ROUTES`, principal de serviço, engine
 * desligado). Nunca `[]` por omissão — só se o ator realmente não tiver célula.
 */
export function cellsOfRequest(req: Request): string[] | null {
  return req.permissionCells ?? null;
}
