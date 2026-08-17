/**
 * O wiring é onde o módulo encosta no boot do serviço — e onde um erro custa
 * caro (boot é caminho crítico de TODO o worker-functions, não só do painel).
 * O que se prova aqui: neutro por padrão, gated onde escreve, o GATE de boot do
 * grupo 3 (task 3.7) derrubando SÓ na migração de dados não marcada — e não no
 * catálogo —, e o índice do guard de rota-sem-declaração publicado com a
 * varredura real do router.
 */

import express from 'express';
import {
  createPermissionsBoundary,
  runPermissionsBootTasks,
  wirePermissionsModule,
  type PermissionsBoundary,
} from '../wirePermissionsModule';
import { PERMISSION_CHANGED_EVENT, COUNTRY_FEATURE_CHANGED_EVENT } from '@modules/identity/permissions';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const poolStub = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn() } as never;

function setup(): { app: express.Express; registered: string[]; boundary: PermissionsBoundary } {
  const app = express();
  const registered: string[] = [];
  const boundary = createPermissionsBoundary({ app, pool: poolStub, systemPool: poolStub });
  wirePermissionsModule({
    app,
    boundary,
    events: { registerHandler: (event) => registered.push(event) },
    internalGuard: (_req, _res, next) => next(),
  });
  return { app, registered, boundary };
}

/** A migração de dados marcada — o estado normal depois do grupo 5. */
function comMigracaoMarcada(boundary: PermissionsBoundary): void {
  jest
    .spyOn(boundary.permissions.assertStaffHasGroup, 'execute')
    .mockResolvedValue({ tenantId: 'tenant', count: 0, migrated: true });
}

describe('wirePermissionsModule', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
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
    delete process.env.PERMISSION_ENGINE_ENABLED;
    const { app, boundary } = setup();
    const catalogSync = jest.spyOn(boundary.permissions.catalog.sync, 'execute').mockResolvedValue(null);
    const featureSync = jest
      .spyOn(boundary.permissions.features.sync, 'execute')
      .mockResolvedValue({ synced: 0, failed: 0 });
    const alerta = jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

    await runPermissionsBootTasks(app, boundary);

    expect(catalogSync).not.toHaveBeenCalled();
    expect(featureSync).not.toHaveBeenCalled();
    expect(alerta).toHaveBeenCalledWith(expect.stringMatching(/^0{8}-/), false);
  });

  it('com as flags ligadas, sincroniza catálogo (varrendo o router) e manifest', async () => {
    process.env.PERMISSION_CATALOG_SYNC_ENABLED = 'true';
    process.env.COUNTRY_FEATURES_SYNC_ENABLED = 'true';
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const { app, boundary } = setup();
    comMigracaoMarcada(boundary);
    const catalogSync = jest.spyOn(boundary.permissions.catalog.sync, 'execute').mockResolvedValue(null);
    const featureSync = jest
      .spyOn(boundary.permissions.features.sync, 'execute')
      .mockResolvedValue({ synced: 1, failed: 0 });
    jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

    await runPermissionsBootTasks(app, boundary);

    // Nenhuma rota declara célula nesta app de teste — a varredura vem vazia e o
    // use case aborta sozinho; o que importa aqui é que a flag chama.
    expect(catalogSync).toHaveBeenCalledWith([]);
    expect(featureSync).toHaveBeenCalled();
  });

  it('publica o índice do guard com a varredura do router', async () => {
    const { app, boundary } = setup();
    app.get('/api/admin/coisas', (_req, res) => res.json({}));
    jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

    await runPermissionsBootTasks(app, boundary);

    // Rota administrativa nova, sem célula e fora das listas: é exatamente o
    // caso que o guard nega e o teste de rotas denuncia.
    expect(boundary.registry.statusOf('GET', '/api/admin/coisas')).toBe('undeclared');
    expect(boundary.registry.unexpectedlyUndeclared().map((r) => r.path)).toContain('/api/admin/coisas');
  });

  describe('gate de boot (task 3.7)', () => {
    it('com o engine LIGADO e a migração de dados NÃO marcada, o boot falha', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      const { app, boundary } = setup();
      jest
        .spyOn(boundary.permissions.assertStaffHasGroup, 'execute')
        .mockResolvedValue({ tenantId: 'tenant', count: 3, migrated: false });

      await expect(runPermissionsBootTasks(app, boundary)).rejects.toThrow(/iam\.rollout_state/);
    });

    it('com o engine DESLIGADO, a migração não marcada não impede o boot', async () => {
      delete process.env.PERMISSION_ENGINE_ENABLED;
      const { app, boundary } = setup();
      const execute = jest
        .spyOn(boundary.permissions.assertStaffHasGroup, 'execute')
        .mockResolvedValue({ tenantId: 'tenant', count: 3, migrated: false });
      jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

      await expect(runPermissionsBootTasks(app, boundary)).resolves.toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
    });

    // ⚠️ Ao contrário do que a task 3.7 previa, catálogo NÃO derruba o boot: o
    // use case do grupo 2 devolve `null` em falha e em varredura vazia ("catálogo
    // velho serve; boot caído não"). Derrubar aqui tiraria do ar a app do
    // prestador por causa da tela de grupo.
    it('catálogo desatualizado NÃO derruba o boot — degrada a tela, não o acesso', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      process.env.PERMISSION_CATALOG_SYNC_ENABLED = 'true';
      const { app, boundary } = setup();
      comMigracaoMarcada(boundary);
      const sync = jest.spyOn(boundary.permissions.catalog.sync, 'execute').mockResolvedValue(null);
      jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

      await expect(runPermissionsBootTasks(app, boundary)).resolves.toBeUndefined();
      expect(sync).toHaveBeenCalled();
    });

    // Os dois casos que a revisão do grupo 3 separou: "marcador AUSENTE" derruba,
    // "não consegui LER o marcador" não. Sem essa distinção, uma oscilação de
    // conexão no boot tirava do ar app do prestador, leads e webhooks.
    it('falha ao LER iam.rollout_state não derruba o boot', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      const { app, boundary } = setup();
      jest
        .spyOn(boundary.permissions.assertStaffHasGroup, 'execute')
        .mockRejectedValue(new Error('connection terminated unexpectedly'));
      const alerta = jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

      await expect(runPermissionsBootTasks(app, boundary)).resolves.toBeUndefined();
      expect(alerta).toHaveBeenCalled();
    });

    it('qualquer outra falha do boot é logada e o processo segue', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      process.env.COUNTRY_FEATURES_SYNC_ENABLED = 'true';
      const { app, boundary } = setup();
      comMigracaoMarcada(boundary);
      jest
        .spyOn(boundary.permissions.features.sync, 'execute')
        .mockRejectedValue(new Error('banco fora'));

      await expect(runPermissionsBootTasks(app, boundary)).resolves.toBeUndefined();
      const { logger } = jest.requireMock('@shared/logging') as { logger: { error: jest.Mock } };
      expect(logger.error.mock.calls.some((c) => String(c[1]).includes('seguindo sem elas'))).toBe(true);
    });

    it('staff sem grupo é ALERTA, nunca falha de boot (lex C2)', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      const { app, boundary } = setup();
      jest
        .spyOn(boundary.permissions.assertStaffHasGroup, 'execute')
        .mockResolvedValue({ tenantId: 'tenant', count: 42, migrated: true });
      const alerta = jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

      await expect(runPermissionsBootTasks(app, boundary)).resolves.toBeUndefined();
      expect(alerta).toHaveBeenCalledWith(expect.stringMatching(/^0{8}-/), true);
    });
  });
});

/** Caminhos montados na app (só para afirmar que o /.well-known entrou). */
function scanPaths(app: express.Express): string[] {
  const stack = (app as unknown as { _router?: { stack: Array<{ regexp?: RegExp }> } })._router?.stack ?? [];
  return stack.map((layer) => String(layer.regexp));
}
