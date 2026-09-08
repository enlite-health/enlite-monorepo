/**
 * WorkerControllerV2Helpers
 *
 * Extraído de `WorkerControllerV2.ts` porque o controller estava EXATAMENTE no
 * teto de 400 linhas do `worker-functions/CLAUDE.md` e a mudança de completude
 * o levou a 439. Mesmo padrão de `AdminWorkersControllerHelpers.ts`.
 *
 * O ganho não é só linha: aqui estes helpers ficam testáveis sem instanciar o
 * controller inteiro (que constrói ~8 use cases, Twilio e PubSub no construtor).
 */

import { Response } from 'express';
import { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { WORKER_ERROR_CODES } from '../../domain/workerErrors';
import { readWorkerMissingFields } from '../../infrastructure/WorkerCompletenessRepository';

const TAG = '[WorkerControllerV2Helpers]';

/**
 * Mensagem amigável (pt-BR fallback do backend) para PHONE_NOT_AVAILABLE.
 * Por privacidade NÃO revela que o número pertence a outra conta. O frontend
 * localiza a partir do `code`; esta string é a rede de segurança caso não o faça.
 */
export const PHONE_NOT_AVAILABLE_MESSAGE = 'El teléfono ingresado no puede ser utilizado.';

/**
 * Traduz a falha de salvamento de info pessoal para a resposta HTTP.
 * Códigos de domínio conhecidos (ex.: PHONE_NOT_AVAILABLE) viram status +
 * `code` + mensagem amigável; qualquer outro erro mantém o 400 genérico.
 */
export function sendPersonalInfoFailure(res: Response, error: string | undefined): void {
  if (error === WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE) {
    res.status(409).json({
      success: false,
      code: WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE,
      error: PHONE_NOT_AVAILABLE_MESSAGE,
    });
    return;
  }
  res.status(400).json({ success: false, error });
}

/**
 * Anexa `missingFields` ao worker devolvido ao prestador.
 *
 * `missingFields: []` = "nada falta". `missingFields: null` = "não consegui
 * apurar" — e o cliente TEM de tratar null como desconhecido, nunca como
 * completo. São coisas diferentes de propósito: confundir "ausência de
 * informação" com "informação de ausência" é a causa raiz deste conserto (D302).
 */
export async function withMissingFields<T extends { id: string }>(
  pool: Pool,
  worker: T,
): Promise<T & { missingFields: string[] | null }> {
  const missingFields = await readWorkerMissingFields(pool, worker.id);
  return { ...worker, missingFields };
}

/**
 * Resolve só o `id` do worker a partir do `auth_uid`.
 *
 * Existe para NÃO pagar a leitura completa duas vezes no `PUT
 * /me/general-info`. `findByAuthUid` decripta 9 campos por KMS, e o
 * `KMSEncryptionService` não tem cache — usá-lo só para descobrir o id, e
 * depois de novo para reler o estado gravado, dobrava o tráfego KMS num
 * endpoint que é AUTOSAVE (dispara a cada blur de campo, não a cada submit).
 * Medido no gate `revisao-pr` de 08/09/2026: ia de ~1 SELECT + 9 KMS para
 * ~3 SELECT + 18 KMS por blur.
 *
 * `WHERE w.auth_uid = $1` espelha EXATAMENTE o `findByAuthUid`
 * (`WorkerAuthRepository.ts:45`) — sem filtro de merge e sem LIMIT — para os
 * dois nunca resolverem workers diferentes.
 */
export async function resolveWorkerIdByAuthUid(
  pool: Pool,
  authUid: string,
): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT w.id FROM workers w WHERE w.auth_uid = $1',
      [authUid],
    );
    return rows.length > 0 ? rows[0].id : null;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: 'WorkerControllerV2Helpers:resolveWorkerIdByAuthUid' });
    return null;
  }
}

/**
 * Estado devolvido por uma escrita que não pôde ser confirmada.
 * `missingFields: null` mantém o contrato: "gravei, mas não sei te dizer o
 * estado" — nunca "está completo".
 */
export const UNCONFIRMED_WRITE = { message: 'General info saved', missingFields: null } as const;

/**
 * Relê o cadastro pelo MESMO caminho do `GET /me`, para a resposta de uma
 * escrita ser o estado real (com PII decriptada) e não um eco do payload.
 *
 * Se a releitura falhar, devolve `UNCONFIRMED_WRITE` — mas NÃO em silêncio: o
 * estado é anômalo por construção (a mesma leitura acabou de suceder nesta
 * request, para resolver o id), então ou o worker sumiu no meio da escrita ou o
 * banco caiu. O cliente recebe 200 e ninguém acordaria — por isso vai a
 * `reportError`, que é o que chega ao Error Reporting.
 */
export async function readFreshProgress<T extends { id: string }>(
  pool: Pool,
  reread: () => Promise<T | null>,
  authUid: string,
): Promise<unknown> {
  let fresh: T | null = null;
  try {
    fresh = await reread();
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: 'WorkerControllerV2Helpers:readFreshProgress' });
    return UNCONFIRMED_WRITE;
  }

  if (!fresh) {
    reportError(
      new Error('re-read after successful write returned no worker'),
      { source: 'WorkerControllerV2Helpers:readFreshProgress' },
    );
    logger.child({ authUidPresent: Boolean(authUid) }).warn({
      msg: `${TAG} escrita confirmada indisponível — devolvendo missingFields: null`,
    });
    return UNCONFIRMED_WRITE;
  }

  return withMissingFields(pool, fresh);
}
