/**
 * withMulterErrorAsJson.test.ts — extraído de `adminPatientPhotoRoutes.ts` na spec 022, Bloco 3
 * (T312), para reuso sem duplicação na rota de anexo de conversa. Comportamento já coberto
 * indiretamente por `adminPatientPhotoRoutes.test.ts` (via HTTP real) — este arquivo testa a
 * função isolada, unitário e rápido.
 */
import type { Request, Response } from 'express';
import multer from 'multer';
import { withMulterErrorAsJson } from '../withMulterErrorAsJson';

function fakeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('withMulterErrorAsJson', () => {
  it('sem erro — chama next() sem tocar a resposta', () => {
    const single = jest.fn((_req, _res, cb: (err?: unknown) => void) => cb());
    const mw = { single: jest.fn(() => single) } as unknown as ReturnType<typeof multer>;
    const next = jest.fn();
    const res = fakeRes();

    withMulterErrorAsJson(mw)('file')({} as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('erro LIMIT_FILE_SIZE — 413 JSON normalizado com code FILE_TOO_LARGE, nunca chama next()', () => {
    const single = jest.fn((_req, _res, cb: (err?: unknown) => void) => cb({ code: 'LIMIT_FILE_SIZE' }));
    const mw = { single: jest.fn(() => single) } as unknown as ReturnType<typeof multer>;
    const next = jest.fn();
    const res = fakeRes();

    withMulterErrorAsJson(mw)('file')({} as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Arquivo excede o limite', code: 'FILE_TOO_LARGE' });
    expect(next).not.toHaveBeenCalled();
  });

  it('outro erro do multer (ex.: LIMIT_UNEXPECTED_FILE) — 400 genérico, nunca chama next()', () => {
    const single = jest.fn((_req, _res, cb: (err?: unknown) => void) => cb({ code: 'LIMIT_UNEXPECTED_FILE' }));
    const mw = { single: jest.fn(() => single) } as unknown as ReturnType<typeof multer>;
    const next = jest.fn();
    const res = fakeRes();

    withMulterErrorAsJson(mw)('file')({} as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Falha no upload multipart' });
    expect(next).not.toHaveBeenCalled();
  });
});
