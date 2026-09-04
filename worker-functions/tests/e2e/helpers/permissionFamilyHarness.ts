/**
 * permissionFamilyHarness — o wiring compartilhado dos e2e do painel de grupos.
 *
 * Por que existe (gate de revisão, 19/08/2026): a 2ª família da task 3.5 copiou
 * 21 linhas do `beforeAll` da 1ª, e o mesmo bloco de construção do módulo de
 * permissões apareceu 3 vezes no repo. Com 7 famílias e 120 rotas ainda por
 * virar, isso vira 9 cópias — e o que está duplicado não é enfeite: é o CONTRATO
 * do wiring real (`pool` × `systemPool` × `staffRoles` × ordem dos middlewares) e
 * a lista de tabelas `iam.*` a limpar. Uma tabela nova no schema (o design prevê
 * países por grupo) teria que ser lembrada em 9 lugares, e vazamento entre
 * suítes é justamente a classe de bug que já mordeu esta change uma vez.
 *
 * ⚠️ NENHUM import de `src/` no topo deste arquivo — só `import type`, que o tsc
 * apaga. As suítes escrevem as envs de flag ANTES do primeiro import de `src/`;
 * um import estático aqui carregaria o módulo cedo demais e a flag não valeria.
 * Por isso todo `import()` acontece DENTRO das funções.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import type { PermissionsModule } from '@modules/identity/permissions';

/** O tenant único de hoje — o mesmo que `ENLITE_TENANT_ID` no domínio. */
export const TENANT_E2E = '00000000-0000-0000-0000-000000000001';

/** Credencial do `mockAuthMiddleware` (USE_MOCK_AUTH=true). */
export function tokenMock(uid: string, role = 'admin'): string {
  const dados = Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');
  return `Bearer mock_${dados}`;
}

export interface MontarAppOpts {
  /**
   * Monta as rotas da família no app. Recebe as peças REAIS já construídas —
   * quem chama decide o prefixo e quais controllers entram.
   */
  montarRotas: (deps: {
    app: Express;
    auth: AuthMiddleware;
    permissions: PermissionMiddleware;
    /**
     * O MÓDULO de permissões (use cases + repositórios), para as rotas do
     * PAINEL — que não consomem um controller, consomem o use case direto.
     * As famílias antigas ignoram este campo.
     */
    modulo: PermissionsModule;
  }) => void;
  /**
   * Sobrescreve `PERMISSION_ENFORCED_ROUTES` só para ESTA app, sem mexer no
   * processo — é como se testa "família fora da lista não muda nada" sem
   * derrubar as outras asserções da suíte.
   */
  enforcedRoutes?: string;
  /** TTL do cache de permissões. 0 (default) = cada request resolve de novo. */
  ttlMs?: number;
  /**
   * `AuthMiddleware` pronto — para a suíte que precisa do `MultiAuthService` de
   * produção (é ele que liga o claim de país ao GUC lido pela policy). Omitido,
   * o harness monta um que não autentica por conta própria (o `mockAuth` já
   * resolveu o `req.user`).
   */
  auth?: AuthMiddleware;
}

export interface AppDeFamilia {
  url: string;
  servidor: Server;
  /** Para invalidar cache à mão no teste que observa TTL. */
  invalidar: (uids: string[]) => void;
  fechar: () => Promise<void>;
}

/**
 * Sobe a CADEIA DE VERDADE do `src/index.ts` numa porta efêmera:
 * `correlationMiddleware` → `dbSessionMiddleware` → `mockAuthMiddleware` →
 * `AuthMiddleware` (com o `PermissionClient` de produção) → `PermissionMiddleware`
 * → as rotas da família.
 */
export async function montarAppDeFamilia(opts: MontarAppOpts): Promise<AppDeFamilia> {
  const express = (await import('express')).default;
  const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
  const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  const identity = await import('@modules/identity');
  const { createPermissionsModule } = await import('@modules/identity/permissions');

  const db = DatabaseConnection.getInstance();
  const permissions = createPermissionsModule({
    pool: db.getPool(),
    systemPool: db.getSystemPool(),
    // A constante do domínio, não um literal: o harness se anuncia como a cadeia
    // de verdade do `src/index.ts`, e é ela que o `src/index.ts` usa. Papel novo
    // no `STAFF_ROLES` tem que valer aqui sem ninguém lembrar de editar o teste.
    staffRoles: [...identity.STAFF_ROLES],
    ttlMs: opts.ttlMs ?? 0,
  });

  const auth =
    opts.auth ??
    new identity.AuthMiddleware(
      { parseCredentials: () => null, authenticate: async () => null } as never,
      new identity.SimplifiedAuthorizationEngine(),
      permissions.client,
    );

  const permissionMiddleware = new identity.PermissionMiddleware({
    client: permissions.client,
    audit: permissions.repositories.audit,
    ...(opts.enforcedRoutes === undefined
      ? {}
      : { env: { ...process.env, PERMISSION_ENFORCED_ROUTES: opts.enforcedRoutes } }),
  });

  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);
  app.use(dbSessionMiddleware);
  app.use(identity.mockAuthMiddleware);
  opts.montarRotas({ app, auth, permissions: permissionMiddleware, modulo: permissions });

  const servidor = app.listen(0);
  await new Promise<void>((resolve) => servidor.once('listening', () => resolve()));

  return {
    servidor,
    url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
    invalidar: (uids) => permissions.client.invalidate(uids),
    fechar: () => new Promise<void>((resolve) => servidor.close(() => resolve())),
  };
}

/**
 * Apaga as fixtures de `iam.*` de uma suíte de família, na ordem que as FKs
 * exigem (trilha → mudanças → vínculos → células → grupos → usuários).
 *
 * Centralizado porque a LISTA é o contrato: schema novo no `iam` significa uma
 * linha aqui, não uma caçada por 9 suítes.
 */
export async function limparIamFixtures(
  pool: Pool,
  alvo: { uids: string[]; grupos: string[] },
): Promise<void> {
  const { uids, grupos } = alvo;
  await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [uids]);
  await pool.query(
    `DELETE FROM iam.permission_group_changes WHERE group_id IN
       (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`,
    [grupos],
  );
  await pool.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [uids]);
  await pool.query(
    `DELETE FROM iam.group_permissions WHERE group_id IN
       (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`,
    [grupos],
  );
  await pool.query(`DELETE FROM iam.permission_groups WHERE name = ANY($1)`, [grupos]);
  await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [uids]);
}

/**
 * Um grupo com EXATAMENTE as células pedidas, e a pessoa dentro dele.
 *
 * Célula que não existe em `iam.permissions` faria o grupo nascer VAZIO e o teste
 * passar por engano ("negou porque não tinha" em vez de "negou porque a célula
 * certa é outra"). Por isso falha alto em vez de seguir.
 */
export async function grupoComCelulas(
  pool: Pool,
  args: { nome: string; uid: string; celulas: Array<[string, string]> },
): Promise<string> {
  const grupo = await pool.query(
    `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`,
    [TENANT_E2E, args.nome],
  );
  const id = grupo.rows[0].id as string;

  for (const [resource, action] of args.celulas) {
    const inseriu = await pool.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id)
         SELECT $1, id FROM iam.permissions WHERE resource = $2 AND action = $3
       RETURNING permission_id`,
      [id, resource, action],
    );
    if (inseriu.rowCount !== 1) {
      throw new Error(`célula ${resource}:${action} não existe em iam.permissions — o seed do teste está errado`);
    }
  }

  await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
    args.uid,
    id,
    TENANT_E2E,
  ]);
  return id;
}

/**
 * Garante que a célula existe em `iam.permissions` — algumas nasceram FORA do
 * seed da mig 206 (`integration:execute`, `test_fixtures:execute`,
 * `messaging:write`, ver A4) e só entram quando o A7 ligar
 * `PERMISSION_CATALOG_SYNC_ENABLED`. `grupoComCelulas` falha alto se a célula
 * não existir, então quem monta grupo para uma célula NOVA precisa chamar
 * isto antes. `ON CONFLICT DO NOTHING`: idempotente entre suítes que
 * compartilham célula (ex.: `dedup:execute` é usada por `admin.dedup` E por
 * `admin.analytics`).
 */
export async function garantirCelula(
  pool: Pool,
  args: { resource: string; action: string; category: string },
): Promise<{ criada: boolean }> {
  const inseriu = await pool.query(
    `INSERT INTO iam.permissions (resource, action, description, category)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (resource, action) DO NOTHING
     RETURNING resource`,
    [args.resource, args.action, `${args.resource}:${args.action} (e2e — garantida se ausente)`, args.category],
  );
  // `criada: true` só quando O INSERT aconteceu (RETURNING veio com linha) —
  // é o que diz ao chamador se ele é DONO da célula e precisa apagá-la no
  // cleanup, ou se ela já existia (seed 206 / outra suíte) e apagar destruiria
  // dado de quem chegou primeiro.
  return { criada: (inseriu.rowCount ?? 0) > 0 };
}

/**
 * Controller-substituto GENÉRICO: qualquer propriedade acessada devolve um
 * handler-marcador que responde 200 com `{ chegou: '<namespace>.<método>' }`.
 *
 * Por que existe: as 8 suítes de família única listam o controller inteiro à
 * mão (às vezes 30+ métodos) porque cada uma exercita VÁRIAS rotas da família.
 * O e2e de C1 (12 famílias juntas) exercita só UMA rota por família — mas
 * ainda tem que MONTAR o router inteiro (a rota escolhida vem da varredura
 * VIVA, não de uma linha fixa), e `createXRoutes(...)` só REGISTRA os
 * handlers na montagem — nunca os invoca. Por isso um `Proxy` que responde a
 * qualquer nome de método cobre o router inteiro sem listar métodos que o
 * teste nunca chama, e sem arriscar `undefined is not a function` se a rota
 * sorteada mudar. Mock do jest é proibido aqui (memória do repo) — isto não é
 * mock de módulo: é o MESMO objeto controller-marcador que as 8 suítes já
 * usam, só que genérico em vez de listado propriedade por propriedade.
 */
export function controllerStub(namespace: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get:
        (_target, prop) =>
        (_req: unknown, res: { json: (body: unknown) => void }): void =>
          res.json({ chegou: `${namespace}.${String(prop)}` }),
    },
  );
}

export interface AppComTodasFamilias extends AppDeFamilia {
  /** O módulo de permissões REAL do boundary — para famílias como
   * `admin.permissions`, que consomem use case direto em vez de controller. */
  modulo: PermissionsModule;
}

export interface MontarAppCompletoOpts {
  /** Monta TODAS as rotas da app — quem chama decide famílias, prefixos e ordem. */
  montarRotas: (deps: {
    app: Express;
    auth: AuthMiddleware;
    permissions: PermissionMiddleware;
    modulo: PermissionsModule;
  }) => void;
  /** `AuthMiddleware` pronto — para o bloco que precisa de `MultiAuthService`
   * de produção (chave de API real da Luz). Omitido, usa o fake do harness. */
  auth?: AuthMiddleware;
  /** Segredo que o guard interno (`X-Internal-Secret`) exige para o
   * `/.well-known/permissions/routes` desta app. */
  internalSecret: string;
}

/**
 * Sobe a CADEIA DE VERDADE COMPLETA — não só o `PermissionMiddleware` que
 * `montarAppDeFamilia` usa, mas os TRÊS passos do boot real
 * (`src/bootstrap/wirePermissionsModule.ts`): `createPermissionsBoundary`
 * (deny-by-default ANTES das rotas) → rotas → `wirePermissionsModule`
 * (`/.well-known/permissions/routes` DEPOIS das rotas) →
 * `runPermissionsBootTasks` (varre o router e PUBLICA o índice, do jeito que
 * `src/index.ts` faz antes do `listen`).
 *
 * Por que uma função à parte de `montarAppDeFamilia`: aquela existe para
 * UMA família de cada vez e nunca publica o índice de rotas nem monta o
 * inventário — não há colisão entre famílias para detectar com uma peça só.
 * Este helper é o que o e2e de C1 (as 12 famílias juntas, engine ligado)
 * precisa: o MESMO wiring que `src/index.ts` roda em produção, para que
 * "colisão real entre famílias" seja um achado do wiring de verdade, não de
 * uma reimplementação paralela dele.
 */
export async function montarAppComTodasFamilias(opts: MontarAppCompletoOpts): Promise<AppComTodasFamilias> {
  const express = (await import('express')).default;
  const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
  const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  const identity = await import('@modules/identity');
  const { internalAuthMiddleware } = await import(
    '@modules/notification/interfaces/middleware/InternalAuthMiddleware'
  );
  const { createPermissionsBoundary, wirePermissionsModule, runPermissionsBootTasks } = await import(
    '../../../src/bootstrap/wirePermissionsModule'
  );

  const db = DatabaseConnection.getInstance();
  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);
  app.use(dbSessionMiddleware);
  app.use(identity.mockAuthMiddleware);

  const boundary = createPermissionsBoundary({ app, pool: db.getPool(), systemPool: db.getSystemPool() });

  const auth =
    opts.auth ??
    new identity.AuthMiddleware(
      { parseCredentials: () => null, authenticate: async () => null } as never,
      new identity.SimplifiedAuthorizationEngine(),
      boundary.permissions.client,
    );

  opts.montarRotas({ app, auth, permissions: boundary.middleware, modulo: boundary.permissions });

  process.env.INTERNAL_TOKEN_SECRET = opts.internalSecret;
  wirePermissionsModule({
    app,
    boundary,
    events: { registerHandler: () => {} },
    internalGuard: internalAuthMiddleware,
  });

  // O 3º passo: varre o router JÁ COM TODAS AS ROTAS montadas e publica o
  // índice que `denyUndeclaredRoutes` e o inventário `/.well-known` leem.
  // Sem isto o guard responde `unknown` para tudo (nasce vazio de propósito) e
  // `undeclared`/`governedRoutes` do inventário ficam vazios também.
  await runPermissionsBootTasks(app, boundary);

  const servidor = app.listen(0);
  await new Promise<void>((resolve) => servidor.once('listening', () => resolve()));

  return {
    servidor,
    url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
    invalidar: (uids) => boundary.permissions.client.invalidate(uids),
    fechar: () => new Promise<void>((resolve) => servidor.close(() => resolve())),
    modulo: boundary.permissions,
  };
}
