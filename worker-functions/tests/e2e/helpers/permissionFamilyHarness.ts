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
  montarRotas: (deps: { app: Express; auth: AuthMiddleware; permissions: PermissionMiddleware }) => void;
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
    staffRoles: ['admin', 'recruiter', 'community_manager'],
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
  opts.montarRotas({ app, auth, permissions: permissionMiddleware });

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
  args: { nome: string; uid: string; celulas: Array<[string, string]>; tenant?: string },
): Promise<string> {
  const tenant = args.tenant ?? TENANT_E2E;
  const grupo = await pool.query(
    `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`,
    [tenant, args.nome],
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
    tenant,
  ]);
  return id;
}
