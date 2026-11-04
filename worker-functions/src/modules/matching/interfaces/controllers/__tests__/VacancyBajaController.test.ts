/** VacancyBajaController (spec 084 F1): validação do corpo, recusa em lote com mensagens es/pt-BR, Talentum SÓ pós-commit e só pause. */
const mockPool = { query: jest.fn() };
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue(mockPool) }) },
}));
jest.mock('@shared/database/requestDbSession', () => ({
  ...jest.requireActual('@shared/database/requestDbSession'),
  withSystemDbContext: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
jest.mock('@shared/logging', () => ({ ...jest.requireActual('@shared/logging'), reportError: jest.fn(), loggingAls: { getStore: () => undefined } }));

import { VacancyBajaController } from '../VacancyBajaController';
import type { Request, Response } from 'express';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const reqRes = (body: unknown): [Request, Response] => [
  { body, user: { uid: 'uid-1' } } as unknown as Request,
  { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response,
];
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('VacancyBajaController', () => {
  it('corpo inválido (não-UUID, vazio, mais de 200) → 400 e nada é executado', async () => {
    const useCase = { execute: jest.fn() };
    const ctrl = new VacancyBajaController(useCase as never, { pause: jest.fn(), resume: jest.fn() });
    for (const body of [{}, { vacancyIds: [] }, { vacancyIds: ['x'] }, { vacancyIds: Array(201).fill(A) }]) {
      const [req, res] = reqRes(body);
      await ctrl.baja(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('sucesso: 200 com as baixadas, motivo MANUAL, ator humano; depois do commit PAUSA o Talentum (e só isso)', async () => {
    const useCase = { execute: jest.fn(async () => ({ ok: true, baixadas: [{ vacancyId: A, statusBefore: 'SEARCHING' }, { vacancyId: B, statusBefore: 'CLOSED' }] })) };
    const side = { pause: jest.fn(async () => []), resume: jest.fn() };
    const ctrl = new VacancyBajaController(useCase as never, side as never);
    const [req, res] = reqRes({ vacancyIds: [A, B] });
    await ctrl.baja(req, res);
    await tick();
    expect(useCase.execute).toHaveBeenCalledWith([A, B], 'MANUAL', expect.objectContaining({ actorType: 'HUMAN', actorUserId: 'uid-1' }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(side.pause).toHaveBeenCalledWith([A, B]);
    expect(side.resume).not.toHaveBeenCalled();
  });

  it('lote recusado: 409 BAJA_REFUSED com mensagem es E pt-BR por vaga; Talentum não é tocado', async () => {
    const useCase = { execute: jest.fn(async () => ({ ok: false, refused: [{ vacancyId: B, code: 'VACANCY_HAS_SERVICE' }, { vacancyId: A, code: 'VACANCY_NOT_FOUND' }] })) };
    const side = { pause: jest.fn(), resume: jest.fn() };
    const ctrl = new VacancyBajaController(useCase as never, side as never);
    const [req, res] = reqRes({ vacancyIds: [A, B] });
    await ctrl.baja(req, res);
    await tick();
    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.code).toBe('BAJA_REFUSED');
    expect(body.refused[0].messages.es).toMatch(/Pausar/);
    expect(body.refused[0].messages['pt-BR']).toMatch(/Pausar/);
    expect(body.refused[1].messages.es).toMatch(/no encontrada/);
    expect(side.pause).not.toHaveBeenCalled();
  });

  it('erro do banco → 500, sem Talentum', async () => {
    const useCase = { execute: jest.fn(async () => { throw new Error('db fora'); }) };
    const side = { pause: jest.fn(), resume: jest.fn() };
    const [req, res] = reqRes({ vacancyIds: [A] });
    await new VacancyBajaController(useCase as never, side as never).baja(req, res);
    await tick();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(side.pause).not.toHaveBeenCalled();
  });
});
