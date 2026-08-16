/**
 * O wiring é onde o módulo encosta no boot do serviço — e onde um erro custa
 * caro (boot é caminho crítico de TODO o worker-functions, não só do painel).
 * O que se prova aqui: neutro por padrão, gated onde escreve, e nada que possa
 * derrubar o processo.
 */

import express from 'express';
import { runPermissionsBootTasks, wirePermissionsModule } from '../wirePermissionsModule';
import { PERMISSION_CHANGED_EVENT, COUNTRY_FEATURE_CHANGED_EVENT } from '@modules/identity/permissions';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const poolStub = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn() } as never;

function setup() {
  const app = express();
  const registered: string[] = [];
  const permissions = wirePermissionsModule({
    app,
    pool: poolStub,
    systemPool: poolStub,
    events: { registerHandler: (event) => registered.push(event) },
    internalGuard: (_req, _res, next) => next(),
  });
  return { app, registered, permissions };
}

describe('wirePermissionsModule', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('registra os handlers de invalidação e monta o /.well-known', () => {
    const { registered, app } = setup();
    expect(registered.sort()).toEqual([COUNTRY_FEATURE_CHANGED_EVENT, PERMISSION_CHANGED_EVENT]);
    const rotas = scanPaths(app);
    expect(rotas.some((path) => path.includes('.well-known'))).toBe(true);
  });

  it('sem flags: NÃO sincroniza nada (nenhuma escrita no banco no boot)', async () => {
    delete process.env.PERMISSION_CATALOG_SYNC_ENABLED;
    delete process.env.COUNTRY_FEATURES_SYNC_ENABLED;
    const { app, permissions } = setup();
    const catalogSync = jest.spyOn(permissions.catalog.sync, 'execute').mockResolvedValue(null);
    const featureSync = jest.spyOn(permissions.features.sync, 'execute').mockResolvedValue({ synced: 0, failed: 0 });
    const alerta = jest.spyOn(permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

    await runPermissionsBootTasks(app, permissions);

    expect(catalogSync).not.toHaveBeenCalled();
    expect(featureSync).not.toHaveBeenCalled();
    expect(alerta).toHaveBeenCalledWith(expect.stringMatching(/^0{8}-/), false);
  });

  it('com as flags ligadas, sincroniza catálogo (varrendo o router) e manifest', async () => {
    process.env.PERMISSION_CATALOG_SYNC_ENABLED = 'true';
    process.env.COUNTRY_FEATURES_SYNC_ENABLED = 'true';
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const { app, permissions } = setup();
    const catalogSync = jest.spyOn(permissions.catalog.sync, 'execute').mockResolvedValue(null);
    const featureSync = jest.spyOn(permissions.features.sync, 'execute').mockResolvedValue({ synced: 1, failed: 0 });
    jest.spyOn(permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

    await runPermissionsBootTasks(app, permissions);

    // hoje nenhuma rota declara célula (grupo 3) — a varredura vem vazia e o
    // use case aborta sozinho; o que importa aqui é que a flag chama.
    expect(catalogSync).toHaveBeenCalledWith([]);
    expect(featureSync).toHaveBeenCalled();
  });
});

/** Caminhos montados na app (só para afirmar que o /.well-known entrou). */
function scanPaths(app: express.Express): string[] {
  const stack = (app as unknown as { _router?: { stack: Array<{ regexp?: RegExp }> } })._router?.stack ?? [];
  return stack.map((layer) => String(layer.regexp));
}
