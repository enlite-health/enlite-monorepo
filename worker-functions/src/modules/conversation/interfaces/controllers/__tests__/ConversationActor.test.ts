/**
 * ConversationActor.test.ts — spec 022, Bloco 3 (conserto do gate revisao-pr, Critério 2):
 * `MissingActorError`/`actorUid` estavam DUPLICADOS byte a byte em `AdminConversationController.ts`
 * e `AdminConversationAttachmentController.ts` — extraídos para este módulo único, os dois
 * controllers importam. Teste direto do módulo (antes só coberto indiretamente via e2e dos
 * controllers, que não exercitam a mensagem/código de erro em isolamento).
 */
const mockGetAuthContext = jest.fn();
jest.mock('@modules/identity', () => ({
  AuthMiddleware: { getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args) },
}));

import type { Request } from 'express';
import { MissingActorError, actorUid } from '../ConversationActor';

beforeEach(() => mockGetAuthContext.mockReset());

describe('ConversationActor', () => {
  it('ator autenticado: devolve o uid do principal', () => {
    mockGetAuthContext.mockReturnValue({ principal: { id: 'staff:1' } });
    const req = {} as Request;

    expect(actorUid(req)).toBe('staff:1');
  });

  it('sem contexto de auth (AuthMiddleware devolve undefined): lança MissingActorError (401, MISSING_ACTOR)', () => {
    mockGetAuthContext.mockReturnValue(undefined);
    const req = {} as Request;

    expect(() => actorUid(req)).toThrow(MissingActorError);
    try {
      actorUid(req);
      fail('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingActorError);
      expect((err as MissingActorError).code).toBe('MISSING_ACTOR');
      expect((err as MissingActorError).status).toBe(401);
    }
  });

  it('contexto de auth SEM principal.id (uid vazio/undefined): lança MissingActorError da MESMA forma', () => {
    mockGetAuthContext.mockReturnValue({ principal: { id: undefined } });
    const req = {} as Request;

    expect(() => actorUid(req)).toThrow(MissingActorError);
  });
});
