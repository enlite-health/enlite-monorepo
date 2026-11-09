/**
 * acesso-do-cliente F3, T309: toda rota `service`/`public`/`staff` dos routers abaixo declara
 * classe (`routeClass(...)` ou o `requireStaff`). Varre o router REAL com `scanExpressRouter`
 * (controllers-dublê) e reprova se alguma rota ficar com `class == null`. A contagem esperada
 * de rotas por router é fixa: `0` rotas varridas é falha, não sucesso.
 */
import express from 'express';
import { scanExpressRouter } from '@modules/identity/permissions';

const dub = <T>(): T => ({}) as T;

function varrer(montar: (app: express.Express) => void) {
  const app = express();
  montar(app);
  return scanExpressRouter(app);
}

function esperarClasse(rotas: ReturnType<typeof scanExpressRouter>, total: number, classe: string) {
  expect(rotas).toHaveLength(total);
  expect(rotas.filter((r) => r.class == null)).toEqual([]);
  expect(rotas.every((r) => r.class === classe)).toBe(true);
}

describe('T309 lote 1 — rotas service declaram classe', () => {
  it('anacareHoursSyncRoutes (interna)', async () => {
    const { createAnaCareHoursSyncInternalRoutes } = await import('@modules/anacare-hours/interfaces/routes/anacareHoursSyncRoutes');
    esperarClasse(varrer((a) => a.use('/api/internal', createAnaCareHoursSyncInternalRoutes(dub()))), 1, 'service');
  });
  it('itineraryDailyInternalRoutes', async () => {
    const { createItineraryDailyInternalRoutes } = await import('@modules/case/interfaces/routes/itineraryDailyInternalRoutes');
    esperarClasse(varrer((a) => a.use('/api/internal', createItineraryDailyInternalRoutes(dub()))), 1, 'service');
  });
  it('therapeuticContactRemindersInternalRoutes', async () => {
    const { createTherapeuticContactRemindersInternalRoutes } = await import('@modules/case/interfaces/routes/therapeuticContactRemindersInternalRoutes');
    esperarClasse(varrer((a) => a.use('/api/internal', createTherapeuticContactRemindersInternalRoutes(dub()))), 1, 'service');
  });
});
