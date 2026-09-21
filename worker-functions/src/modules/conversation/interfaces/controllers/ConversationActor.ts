import type { Request } from 'express';
import { AuthMiddleware } from '@modules/identity';

/**
 * ConversationActor — extraído do gate revisao-pr (Bloco 3, Critério 2): `MissingActorError` +
 * `actorUid` estavam DUPLICADOS, byte a byte, em `AdminConversationController.ts` e
 * `AdminConversationAttachmentController.ts` (`grep "class MissingActorError"` = 2 hits no
 * módulo). Um único módulo, os dois controllers importam.
 *
 * Ator ausente (`AuthMiddleware` não resolveu identidade) — recusa (o controller converte em
 * 401). Achado do gate revisao-pr (Bloco 1): antes disto, `actorUid` lançava `Error` genérico,
 * que `handleUnexpected` sempre converte em 500 — sessão sem identidade é 401 (não autenticado),
 * nunca erro interno.
 */
export class MissingActorError extends Error {
  readonly code = 'MISSING_ACTOR';
  readonly status = 401;

  constructor() {
    super('escrita exige ator identificado (lex C6)');
    this.name = 'MissingActorError';
  }
}

/** Uid do ator autenticado — lança `MissingActorError` se `AuthMiddleware` não resolveu identidade. */
export function actorUid(req: Request): string {
  const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
  if (!uid) throw new MissingActorError();
  return uid;
}
