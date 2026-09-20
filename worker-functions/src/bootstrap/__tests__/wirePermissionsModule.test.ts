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
import {
  PERMISSION_CHANGED_EVENT,
  COUNTRY_FEATURE_CHANGED_EVENT,
  createPermissionsModule,
} from '@modules/identity/permissions';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const poolStub = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn() } as never;

/**
 * Pool que falha SÓ na leitura do marcador — a falha parcial que o gate
 * apontou: a conexão derruba um statement e os outros passam.
 */
function poolQueFalhaNoMarcador(): never {
  return {
    query: jest.fn().mockImplementation((sql: string) =>
      String(sql).includes('rollout_state')
        ? Promise.reject(Object.assign(new Error('connection terminated'), { code: '57P01' }))
        : Promise.resolve({ rows: [] }),
    ),
    connect: jest.fn(),
  } as never;
}

function setup(pool: never = poolStub): { app: express.Express; registered: string[]; boundary: PermissionsBoundary } {
  const app = express();
  const registered: string[] = [];
  const boundary = createPermissionsBoundary({ app, pool, systemPool: pool });
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
    .mockResolvedValue({ tenantId: 'tenant', count: 0, migrated: true, marker: true ? 'done' : null });
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

  it('🔴 varredura NÃO-vazia sincroniza rota + as células que o código enforça abaixo dela (B1)', async () => {
    // O buraco que o gate `revisao-pr` achou: `worker_contact:read` e
    // `worker:disable` são decididas no CAMPO e na OPERAÇÃO, nunca num
    // `perm.require`. Sem a 2ª fonte elas nunca entravam em `iam.permissions` —
    // e no flip a projeção redigiria nome e telefone para TODO MUNDO.
    process.env.PERMISSION_CATALOG_SYNC_ENABLED = 'true';
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const { app, boundary } = setup();
    comMigracaoMarcada(boundary);
    const catalogSync = jest.spyOn(boundary.permissions.catalog.sync, 'execute').mockResolvedValue(null);
    jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

    // Uma rota que DECLARA — é o que torna a varredura não-vazia.
    app.get('/api/admin/coisa', boundary.middleware.family('t').require('worker', 'read'), (_req, res) => res.end());

    await runPermissionsBootTasks(app, boundary);

    const enviadas = (catalogSync.mock.calls[0][0] as Array<{ resource: string; action: string }>)
      .map((c) => `${c.resource}:${c.action}`);
    expect(enviadas).toContain('worker:read');           // da rota
    expect(enviadas).toContain('worker_contact:read');   // do código
    expect(enviadas).toContain('worker:disable');        // do código
  });

  it('🔴 varredura VAZIA não é mascarada pelas células de código — o sync tem de abortar', async () => {
    // Se a fusão somasse incondicionalmente, varredura vazia chegaria ao use
    // case como "4 células" e ele descontinuaria as 40 de rota de uma vez.
    process.env.PERMISSION_CATALOG_SYNC_ENABLED = 'true';
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const { app, boundary } = setup();
    comMigracaoMarcada(boundary);
    const catalogSync = jest.spyOn(boundary.permissions.catalog.sync, 'execute').mockResolvedValue(null);
    jest.spyOn(boundary.permissions.assertStaffHasGroup, 'alertOnBoot').mockResolvedValue();

    await runPermissionsBootTasks(app, boundary);

    expect(catalogSync).toHaveBeenCalledWith([]);
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

  describe('D268 — `enforcement` do contrato /v1/me/authz, derivado de PERMISSION_ENGINE_ENABLED', () => {
    /**
     * A MESMA leitura que o gate de boot usa (`isEnvFlagOn`), só que aqui a
     * prova é o efeito ponta a ponta: o valor injetado em
     * `createPermissionsModule` chega ao `enforcement` que `GetMyAuthzUseCase`
     * devolve — não a implementação de `isEnvFlagOn` (já coberta em
     * `envFlag.test.ts`), que aqui não se repete.
     */
    async function enforcementCom(boundary: PermissionsBoundary): Promise<string> {
      const resolveStub = jest
        .spyOn(boundary.permissions.repositories.authz, 'snapshot')
        .mockResolvedValue({ uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries: [], groups: [] });
      const contrato = await boundary.permissions.authz.execute({ uid: 'u', tenantId: 't' });
      resolveStub.mockRestore();
      return contrato.enforcement;
    }

    it('sem a env (unset) → "off"', async () => {
      delete process.env.PERMISSION_ENGINE_ENABLED;
      const { boundary } = setup();
      expect(await enforcementCom(boundary)).toBe('off');
    });

    it('PERMISSION_ENGINE_ENABLED="true" → "on"', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      const { boundary } = setup();
      expect(await enforcementCom(boundary)).toBe('on');
    });

    it('PERMISSION_ENGINE_ENABLED="false" → "off"', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'false';
      const { boundary } = setup();
      expect(await enforcementCom(boundary)).toBe('off');
    });

    it('lixo (nem "true" nem "false") → "off" — só a string exata "true" liga', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'yes';
      const { boundary } = setup();
      expect(await enforcementCom(boundary)).toBe('off');
    });

    // `createPermissionsModule` é chamado por outros wirings (o harness de e2e
    // de família, testes isolados) que podem omitir `engineEnabled` de todo —
    // o default do próprio `permissionsModule.ts` também tem de ser 'off'.
    it('createPermissionsModule sem `engineEnabled` (nem passado) → contrato "off"', async () => {
      const permissions = createPermissionsModule({ pool: poolStub, systemPool: poolStub });
      jest
        .spyOn(permissions.repositories.authz, 'snapshot')
        .mockResolvedValue({ uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries: [], groups: [] });
      const contrato = await permissions.authz.execute({ uid: 'u', tenantId: 't' });
      expect(contrato.enforcement).toBe('off');
    });
  });

  describe('gate de boot (task 3.7)', () => {
    it('com o engine LIGADO e a migração de dados NÃO marcada, o boot falha', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      const { app, boundary } = setup();
      jest
        .spyOn(boundary.permissions.assertStaffHasGroup, 'execute')
        .mockResolvedValue({ tenantId: 'tenant', count: 3, migrated: false, marker: false ? 'done' : null });

      await expect(runPermissionsBootTasks(app, boundary)).rejects.toThrow(/iam\.rollout_state/);
    });

    it('com o engine DESLIGADO, a migração não marcada não impede o boot', async () => {
      delete process.env.PERMISSION_ENGINE_ENABLED;
      const { app, boundary } = setup();
      const execute = jest
        .spyOn(boundary.permissions.assertStaffHasGroup, 'execute')
        .mockResolvedValue({ tenantId: 'tenant', count: 3, migrated: false, marker: false ? 'done' : null });
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
    // ⚠️ Este caso NÃO mocka o use case, de propósito: a 1ª versão dele mockava
    // `execute` para rejeitar — caminho que o wiring de produção não consegue
    // produzir, porque o repositório engolia o erro e devolvia `null` (= "não
    // marcado"), e o gate MATAVA o boot. O teste passava e a proteção não
    // existia. Agora a falha entra pelo POOL e sobe a cadeia real
    // repo → use case → gate.
    it('falha ao LER iam.rollout_state não derruba o boot (cadeia real)', async () => {
      process.env.PERMISSION_ENGINE_ENABLED = 'true';
      const { app, boundary } = setup(poolQueFalhaNoMarcador());

      await expect(runPermissionsBootTasks(app, boundary)).resolves.toBeUndefined();
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
        .mockResolvedValue({ tenantId: 'tenant', count: 42, migrated: true, marker: true ? 'done' : null });
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
