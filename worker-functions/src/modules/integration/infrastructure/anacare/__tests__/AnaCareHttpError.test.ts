/**
 * AnaCareHttpError.test.ts — cobre a classe-base compartilhada `AnaCareHttpErrorBase` (achado 3
 * da F2 de anacare-conferencia-de-horas): `AnaCareHttpError` (sessão por cookie, este arquivo) e
 * `AnaCareApiError` (X-Agency-Key, `AnaCareClient.ts`) tinham a mesma forma estrutural
 * (method/path/status/body + mesmo formato de mensagem) duplicada em dois lugares.
 *
 * REGRA DURA: preservar o comportamento observável de cada subclasse — mensagem, `name`,
 * `status`, `body` — porque `AnaCareMirrorProvider.test.ts` já depende do formato de
 * `AnaCareApiError` e não pode quebrar.
 */
import { AnaCareHttpError, AnaCareHttpErrorBase } from '../AnaCareHttpError';
import { AnaCareApiError } from '../AnaCareClient';

describe('AnaCareHttpErrorBase — classe-base compartilhada (achado 3)', () => {
  it('AnaCareHttpError estende AnaCareHttpErrorBase e mantém seu formato de mensagem próprio', () => {
    const err = new AnaCareHttpError('GET', '/api/shifts/', 500, 'boom');
    expect(err).toBeInstanceOf(AnaCareHttpErrorBase);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AnaCareHttpError');
    expect(err.status).toBe(500);
    expect(err.body).toBe('boom');
    expect(err.message).toBe('[AnaCareSessionClient] GET /api/shifts/ — HTTP 500: boom');
  });

  it('AnaCareApiError estende a MESMA AnaCareHttpErrorBase e mantém seu formato de mensagem próprio', () => {
    const err = new AnaCareApiError('POST', '/api/v2/agencies/nurses/', 400, '{"nombre":["obrigatório"]}');
    expect(err).toBeInstanceOf(AnaCareHttpErrorBase);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AnaCareApiError');
    expect(err.status).toBe(400);
    expect(err.body).toBe('{"nombre":["obrigatório"]}');
    expect(err.message).toBe(
      '[AnaCareClient] POST /api/v2/agencies/nurses/ — HTTP 400: {"nombre":["obrigatório"]}',
    );
  });

  it('as duas classes continuam DISTINTAS entre si (instanceof não cruza)', () => {
    const sessionErr = new AnaCareHttpError('GET', '/x', 500, 'y');
    const apiErr = new AnaCareApiError('GET', '/x', 500, 'y');
    expect(sessionErr).not.toBeInstanceOf(AnaCareApiError);
    expect(apiErr).not.toBeInstanceOf(AnaCareHttpError);
  });
});
