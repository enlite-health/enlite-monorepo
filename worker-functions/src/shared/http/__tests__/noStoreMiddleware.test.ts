import express from 'express';
import request from 'supertest';
import { Request, Response, NextFunction } from 'express';
import { noStoreMiddleware } from '../noStoreMiddleware';

describe('noStoreMiddleware', () => {
  test('Test 1 — seta Cache-Control: no-store e chama next()', () => {
    const setHeader = jest.fn();
    const next = jest.fn() as NextFunction;

    noStoreMiddleware({} as Request, { setHeader } as unknown as Response, next);

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('Test 2 — resposta de rota comum (incl. 404) sai com no-store', async () => {
    const app = express();
    app.use(noStoreMiddleware);
    app.get('/api/admin/auth/profile', (_req, res) => {
      res.status(404).json({ success: false, error: 'Admin user not found' });
    });

    const res = await request(app).get('/api/admin/auth/profile');

    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('Test 3 — rota que define o próprio Cache-Control sobrescreve o default', async () => {
    const app = express();
    app.use(noStoreMiddleware);
    app.get('/api/public/jobs', (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      res.json({ success: true, data: [] });
    });

    const res = await request(app).get('/api/public/jobs');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300, s-maxage=600');
  });
});
