/**
 * GET /api/admin/pedidos-ia/contadores (spec 081, T094): só-leitura, MESMA célula da página (`pedidos_ia:read`).
 * Guards são dublês (a ordem do array da rota é a real); a consulta real roda no e2e do CI.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  reportError: jest.fn(),
  loggingAls: { getStore: () => undefined },
}));

import { createAdminPedidosIaRoutes } from '../adminPedidosIaRoutes';
import { PedidoIaController } from '../../controllers/PedidoIaController';
import type { ContadoresPedidos } from '../../../infrastructure/PedidoContadorQuery';

const CONTADORES: ContadoresPedidos = {
  contador1: { semanasValidasSeguidas: 3, reguaSemanas: 4, atingiuRegua: false, ultimaContestacaoSemana: '2026-09-28', pendentes: 1, pedidos: 9 },
  contador2: { semanasValidasSeguidas: 0, reguaSemanas: 26, atingiuRegua: false, ultimaContestacaoSemana: null, pendentes: 0, pedidos: 0 },
};

let cells: string[];
const lerContadores = jest.fn(async () => CONTADORES);

function build() {
  const controller = new PedidoIaController({} as never, {} as never, {} as never, lerContadores);
  const auth = {
    requireStaff: () => (req: Request, res: Response, next: NextFunction) => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith('Bearer ')) return void res.status(401).json({ error: 'Unauthenticated' });
      (req as unknown as { authContext: unknown }).authContext = { principal: { id: 'uid-staff' } };
      next();
    },
  };
  const perms = {
    family: () => ({
      require: (resource: string, action: string) => (_req: Request, res: Response, next: NextFunction) =>
        cells.includes(`${resource}:${action}`) ? next() : void res.status(403).json({ error: 'missing_cell' }),
    }),
  };
  const app = express();
  app.use('/api/admin', createAdminPedidosIaRoutes(controller, auth as never, perms as never));
  return app;
}

const URL = '/api/admin/pedidos-ia/contadores';
const TOKEN = { Authorization: 'Bearer tok' };

describe('GET /api/admin/pedidos-ia/contadores', () => {
  beforeEach(() => { cells = ['pedidos_ia:read']; lerContadores.mockClear(); });

  it('com a célula pedidos_ia:read -> 200 com os campos dos dois contadores', async () => {
    const res = await request(build()).get(`${URL}?de=2026-09-01&ate=2026-10-01T00:00:00Z`).set(TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const k of ['contador1', 'contador2']) {
      expect(Object.keys(res.body.data[k]).sort()).toEqual(
        ['atingiuRegua', 'pedidos', 'pendentes', 'reguaSemanas', 'semanasValidasSeguidas', 'ultimaContestacaoSemana'],
      );
    }
    expect(res.body.data.contador1.semanasValidasSeguidas).toBe(3);
    expect(res.body.data.contador2.reguaSemanas).toBe(26);
    expect(res.body.data.janela).toEqual({ de: '2026-09-01T00:00:00.000Z', ate: '2026-10-01T00:00:00.000Z' });
    expect(lerContadores).toHaveBeenCalledWith('uid-staff', { de: new Date('2026-09-01'), ate: new Date('2026-10-01T00:00:00Z') });
  });

  it('sem parâmetros -> 200 com janela padrão de 28 semanas', async () => {
    const res = await request(build()).get(URL).set(TOKEN);
    expect(res.status).toBe(200);
    const { de, ate } = res.body.data.janela;
    expect((Date.parse(ate) - Date.parse(de)) / (7 * 24 * 3600 * 1000)).toBe(28);
  });

  it('sem a célula -> 403 e a consulta não roda', async () => {
    cells = ['pedidos_ia:decidir'];
    const res = await request(build()).get(URL).set(TOKEN);
    expect(res.status).toBe(403);
    expect(lerContadores).not.toHaveBeenCalled();
  });

  it('sem token -> 401', async () => {
    const res = await request(build()).get(URL);
    expect(res.status).toBe(401);
    expect(lerContadores).not.toHaveBeenCalled();
  });

  it.each([['de=ontem'], ['ate=2026-13-45'], ['de=2026-10-02&ate=2026-10-01'], ['de=2026-10-01&ate=2026-10-01']])(
    'entrada inválida (%s) -> 400',
    async (qs) => {
      const res = await request(build()).get(`${URL}?${qs}`).set(TOKEN);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_QUERY');
      expect(lerContadores).not.toHaveBeenCalled();
    },
  );

  it('falha da consulta -> 500 sem vazar a mensagem', async () => {
    lerContadores.mockRejectedValueOnce(new Error('segredo-interno'));
    const res = await request(build()).get(URL).set(TOKEN);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('segredo-interno');
  });
});
