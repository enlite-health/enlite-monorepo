/**
 * A ponte entre a projeção (C3) e a trilha agregada (C6) — B2 do gate.
 *
 * O gate mediu: `contactAccessFromRequest.ts` estava com 12.5% de branch e as
 * linhas 32-36 (o `filter`, o `currentDbContext()` e o `emitContactAccess`
 * inteiro) tinham ZERO execuções. O único teste que citava o arquivo o
 * MOCKAVA (`WJAFunnelController.celulas.test.ts:36-38`), então o que estava
 * verde era "o controller passou a lista certa" — nunca "a linha foi emitida".
 *
 * Aqui o `emitContactAccess` é espionado, não mockado por conveniência: o que
 * este arquivo afirma é o CONTEÚDO do que a ponte manda gravar.
 */

const emitContactAccess = jest.fn();
jest.mock('../contactAccessLog', () => ({ emitContactAccess: (...args: unknown[]) => emitContactAccess(...args) }));

const currentDbContext = jest.fn();
jest.mock('@shared/database/requestDbSession', () => ({ currentDbContext: () => currentDbContext() }));

import type { Request } from 'express';
import { emitirTrilhaDeContato, CELULA_DE_CONTATO } from '../contactAccessFromRequest';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';

const req = (uid?: string) => ({ user: uid ? { uid } : undefined }) as unknown as Request;

describe('emitirTrilhaDeContato', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentDbContext.mockReturnValue({ kind: 'staff', country: 'AR' });
  });

  it('🔴 grava UMA linha agregada com os ids cujo contato de fato saiu', () => {
    emitirTrilhaDeContato(req('uid-recrutadora'), ['w1', 'w2']);

    expect(emitContactAccess).toHaveBeenCalledTimes(1);
    expect(emitContactAccess).toHaveBeenCalledWith({
      tenantId: ENLITE_TENANT_ID,
      operatorUid: 'uid-recrutadora',
      cell: CELULA_DE_CONTATO,
      workerIds: ['w1', 'w2'],
      country: 'AR',
    });
  });

  it('🔴 ator REDIGIDO não gera registro — "tentou ver" é trilha de comportamento (M1-2)', () => {
    // A lista chega com os buracos que a projeção deixou: nada atravessou.
    emitirTrilhaDeContato(req('uid-sem-celula'), [null, undefined, null]);

    expect(emitContactAccess).not.toHaveBeenCalled();
  });

  it('lista vazia não grava', () => {
    emitirTrilhaDeContato(req('uid-x'), []);

    expect(emitContactAccess).not.toHaveBeenCalled();
  });

  it('filtra os nulos e grava só quem atravessou — a página inteira não vai', () => {
    emitirTrilhaDeContato(req('uid-x'), ['w1', null, 'w3', undefined]);

    expect(emitContactAccess.mock.calls[0][0].workerIds).toEqual(['w1', 'w3']);
  });

  it('sem operador identificado não há o que afirmar', () => {
    emitirTrilhaDeContato(req(undefined), ['w1']);

    expect(emitContactAccess).not.toHaveBeenCalled();
  });

  it('contexto que não é de staff grava país `null`, não inventa', () => {
    currentDbContext.mockReturnValue({ kind: 'system' });

    emitirTrilhaDeContato(req('uid-x'), ['w1']);

    expect(emitContactAccess.mock.calls[0][0].country).toBeNull();
  });

  it('staff sem país no contexto também grava `null`', () => {
    currentDbContext.mockReturnValue({ kind: 'staff', country: undefined });

    emitirTrilhaDeContato(req('uid-x'), ['w1']);

    expect(emitContactAccess.mock.calls[0][0].country).toBeNull();
  });

  it('sem contexto nenhum grava `null`', () => {
    currentDbContext.mockReturnValue(undefined);

    emitirTrilhaDeContato(req('uid-x'), ['w1']);

    expect(emitContactAccess.mock.calls[0][0].country).toBeNull();
  });
});
