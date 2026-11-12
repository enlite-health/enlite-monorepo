/**
 * T064b (spec 081, D602a): GET /api/admin/recruitment/activity-per-person.
 * Guards são dublês na ORDEM real (requireStaff -> perm.require -> controller); o use case é falso aqui —
 * a agregação real roda com banco real em tests/repo/RecruiterActivityPerPerson.repo.test.ts.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit';

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createRecruitmentRoutes } from '../recruitmentRoutes';
import { RecruiterActivityController } from '../../controllers/RecruiterActivityController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

const ROW = {
  staffUid: 'uid-sintetico-1', weekStart: '2026-10-26', funnelMoves: 3, statusChanges: 1, profileEdits: 0, totalActions: 4, workers: 2,
};
const ALLOWED_KEYS = ['staffUid', 'weekStart', 'funnelMoves', 'statusChanges', 'profileEdits', 'totalActions', 'workers'].sort();
const execute = jest.fn();
let cells: string[];

function build() {
  const auth = {
    requireStaff: () => (req: Request, res: Response, next: NextFunction) => {
      if (!req.headers.authorization) return void res.status(401).json({ error: 'Unauthenticated' });
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
  app.use('/api', createRecruitmentRoutes(auth as never, perms as never, new RecruiterActivityController({ execute })));
  return app;
}
const TOKEN = { Authorization: 'Bearer tok' };

beforeEach(() => {
  jest.clearAllMocks();
  cells = [];
  execute.mockImplementation(async ({ weeks }: { weeks: number }) => ({ weeks, rows: [ROW] }));
});

describe('GET /api/admin/recruitment/activity-per-person', () => {
  it('com a célula -> 200 e o corpo só tem os campos do contrato (sem e-mail/nome/label/worker_id)', async () => {
    cells = ['recruitment_activity_per_person:read'];
    const r = await request(build()).get('/api/admin/recruitment/activity-per-person').set(TOKEN);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['rows', 'success', 'weeks']);
    expect(r.body.rows).toHaveLength(1);
    expect(Object.keys(r.body.rows[0]).sort()).toEqual(ALLOWED_KEYS);
    expect(execute).toHaveBeenCalledWith({ weeks: 4 });
  });

  it('sem a célula -> 403 e o use case NÃO roda', async () => {
    const r = await request(build()).get('/api/admin/recruitment/activity-per-person').set(TOKEN);
    expect(r.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('sem token -> 401', async () => {
    cells = ['recruitment_activity_per_person:read'];
    const r = await request(build()).get('/api/admin/recruitment/activity-per-person');
    expect(r.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['13', '0', '-1', 'abc', '2.5'])('weeks=%s -> 400', async (w) => {
    cells = ['recruitment_activity_per_person:read'];
    const r = await request(build()).get(`/api/admin/recruitment/activity-per-person?weeks=${w}`).set(TOKEN);
    expect(r.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([['1', 1], ['12', 12]])('weeks=%s (limite) -> 200 e repassa %i', async (w, n) => {
    cells = ['recruitment_activity_per_person:read'];
    const r = await request(build()).get(`/api/admin/recruitment/activity-per-person?weeks=${w}`).set(TOKEN);
    expect(r.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ weeks: n });
  });

  it('falha do use case -> 500 sem vazar a mensagem', async () => {
    cells = ['recruitment_activity_per_person:read'];
    execute.mockRejectedValueOnce(new Error('segredo-interno'));
    const r = await request(build()).get('/api/admin/recruitment/activity-per-person').set(TOKEN);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('segredo-interno');
  });
});
