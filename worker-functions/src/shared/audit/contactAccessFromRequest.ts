/**
 * A ponte entre a projeção (C3) e a trilha agregada (C6).
 *
 * ⚠️ A regra que este arquivo impõe: a linha sai quando o contato DE FATO saiu,
 * e não quando a rota foi chamada. Quem redigiu tudo não gera registro — nada
 * foi revelado, e registrar "tentou ver" vira trilha de comportamento, que é
 * outro tratamento com outra base legal (M1-2 proíbe uso disciplinar).
 *
 * Por isso a assinatura pede a lista dos que SAÍRAM, e não a lista da página: o
 * chamador é obrigado a filtrar, e filtrar é a decisão que se quer explícita.
 */

import type { Request } from 'express';
import { currentDbContext } from '@shared/database/requestDbSession';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';
import { emitContactAccess } from './contactAccessLog';

export const CELULA_DE_CONTATO = 'worker_contact:read';

/**
 * @param workerIdsComContatoVisivel só os prestadores cujo contato ATRAVESSOU.
 *   Lista vazia → nada é gravado, e é o caminho normal do ator redigido.
 */
export function emitirTrilhaDeContato(
  req: Request,
  workerIdsComContatoVisivel: Array<string | null | undefined>,
): void {
  const uid = req.user?.uid;
  // Sem operador identificado não há o que afirmar (mesma regra da trilha irmã).
  if (!uid) return;

  const ids = workerIdsComContatoVisivel.filter((x): x is string => Boolean(x));
  if (ids.length === 0) return;

  const ctx = currentDbContext();
  emitContactAccess({
    tenantId: ENLITE_TENANT_ID,
    operatorUid: uid,
    cell: CELULA_DE_CONTATO,
    workerIds: ids,
    country: ctx && ctx.kind === 'staff' ? ctx.country ?? null : null,
  });
}
