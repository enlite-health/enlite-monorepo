jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { AdminTerminologySearchController } from '../AdminTerminologySearchController';
import { TerminologyUnavailableError } from '../../../domain/UnavailableTerminology';
import { IcdCode } from '../../../domain/IcdCode';
import type { TerminologyPort } from '../../../domain/TerminologyPort';
import type { Response } from 'express';

function mockReq(query: Record<string, unknown> = {}) {
  return { query } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('AdminTerminologySearchController (spec 016 F2)', () => {
  it('constrói com a porta DEFAULT sem erro', () => {
    expect(() => new AdminTerminologySearchController()).not.toThrow();
  });

  it('400 quando q está ausente', async () => {
    const port = { search: jest.fn() };
    const controller = new AdminTerminologySearchController(port as unknown as TerminologyPort);
    const res = mockRes();
    await controller.search(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(port.search).not.toHaveBeenCalled();
  });

  it('200 com {uri,title} — NUNCA code nem chapter', async () => {
    const port = {
      search: jest.fn().mockResolvedValue([
        { uri: 'uri-1', code: IcdCode.parse('6A02.Z'), title: 'Trastorno del espectro autista', chapter: '06' },
      ]),
    };
    const controller = new AdminTerminologySearchController(port as unknown as TerminologyPort);
    const res = mockRes();
    await controller.search(mockReq({ q: 'autista', lang: 'es', chapters: '06,08' }), res);
    expect(port.search).toHaveBeenCalledWith('autista', { lang: 'es', chapters: ['06', '08'] });
    expect(res.status).toHaveBeenCalledWith(200);
    const [payload] = res.json.mock.calls[0];
    expect(payload.data.candidates).toEqual([{ uri: 'uri-1', title: 'Trastorno del espectro autista' }]);
    expect(Object.keys(payload.data.candidates[0])).not.toEqual(expect.arrayContaining(['code', 'chapter']));
  });

  it('503 quando a porta está indisponível (US-4)', async () => {
    const port = { search: jest.fn().mockRejectedValue(new TerminologyUnavailableError('teste')) };
    const controller = new AdminTerminologySearchController(port as unknown as TerminologyPort);
    const res = mockRes();
    await controller.search(mockReq({ q: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('500 quando a porta lança um erro genérico', async () => {
    const port = { search: jest.fn().mockRejectedValue(new Error('boom')) };
    const controller = new AdminTerminologySearchController(port as unknown as TerminologyPort);
    const res = mockRes();
    await controller.search(mockReq({ q: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('500 quando a porta rejeita com algo que NÃO é Error', async () => {
    const port = { search: jest.fn().mockRejectedValue('rejeição crua') };
    const controller = new AdminTerminologySearchController(port as unknown as TerminologyPort);
    const res = mockRes();
    await controller.search(mockReq({ q: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
