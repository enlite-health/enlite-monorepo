/**
 * src/modules/identity/interfaces/routes/permissionPanelWriteRoutes.ts
 *
 * A ESCRITA do painel de acessos (F4, task 4.1 na parte de escrita). Nove
 * rotas, na mesma família `admin.permissions` das de leitura, todas sob
 * `permission_management:write`.
 *
 * ── ⚠️ Onde a autorização REALMENTE mora ─────────────────────────────────────
 * Não é aqui. Cada escrita desce para uma função `SECURITY DEFINER` da mig 279
 * (`iam.create_group`, `iam.add_member`, …), e é lá que `iam._require_manager()`
 * exige `permission_management:write` VIGENTE do ator no GUC, dentro da
 * transação. A role do app teve INSERT/UPDATE/DELETE revogado nas tabelas
 * `iam.*` pela mig 269 — ela não consegue escrever nem se quiser.
 *
 * Isso tem uma consequência que o teste de abuso existe para provar: com
 * `PERMISSION_ENGINE_ENABLED` off, o `perm.require` desta rota é NO-OP, e mesmo
 * assim staff sem a célula recebe erro — porque o BANCO recusa. O portão da
 * rota é a segunda tranca, nunca a única. Se um dia alguém "simplificar"
 * trocando as funções por SQL direto, o teste de abuso fica vermelho antes de a
 * porta abrir.
 *
 * ── O anti-lockout, e o caminho que ele NÃO cobre ────────────────────────────
 * `iam._assert_not_last_manager` roda DEPOIS da mutação, na mesma transação,
 * com `pg_advisory_xact_lock` por tenant (TOCTOU: dois `remove_member`
 * simultâneos veriam um ao outro vivos). Cobre as três destrutivas — medido:
 * `archive_group`, `set_group_permissions`, `remove_member`.
 *
 * ⚠️ **Ele NÃO cobre todos os caminhos, e eu afirmei que cobria.** A nota antiga
 * media por `grep` de `UPDATE users SET status` — régua de FORMA: prova que uma
 * string não aparece, não que a propriedade "zera gestores" é impossível. O gate
 * `revisao-pr` achou TRÊS caminhos vivos hoje, e os dois primeiros são rota:
 *
 *  1. **`PATCH /api/admin/users/:id/role`** (`adminUsersRoutes.ts:69`) — guardada
 *     pela MESMA célula `permission_management:write`. Chama `change_user_role`,
 *     que só faz `UPDATE users SET role` e **não** chama o assert. Trocar o role
 *     do último gestor para não-staff o tranca fora de todo `/api/admin` via
 *     `requireStaff()` — e o assert não vê nada, porque `effective_permissions`
 *     filtra `u.status = 'ACTIVE'` e **não olha `role`** (medido na mig 276).
 *  2. **`DELETE /api/admin/users/:id`** — hard delete; `effective_permissions`
 *     faz `JOIN users`, e sem a linha o gestor some do cálculo.
 *  3. `iam.deprecate_missing_permission_cells` — descontinuar a célula a remove
 *     de `effective_permissions`. É o incidente que já está vermelho na `stage`.
 *
 * Os três são rotas/funções PRÉ-EXISTENTES, fora do diff desta fase — vão para a
 * lista do Gabriel, não para este PR. O que muda aqui é o comentário parar de
 * afirmar cobertura que não existe.
 *
 * A task 4.1 ainda prevê `PATCH /users/:uid` com `status`; quando vier, precisa
 * de `SECURITY DEFINER` próprio chamando o mesmo assert.
 */

import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { COUNTRY_CODES } from '@shared/domain/countryCodes';
import {
  ENLITE_TENANT_ID,
  isPermissionError,
  toPermissionError,
} from '@modules/identity/permissions';
import type { PermissionsModule } from '@modules/identity/permissions';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../middleware/PermissionMiddleware';
import { ADMIN_PERMISSIONS_FAMILY } from './permissionPanelRoutes';
import { MENSAGEM_POR_CODIGO, STATUS_POR_CODIGO } from '../http/permissionErrorHttp';

/**
 * Porta ESTREITA de escrita — só os 9 use cases desta fase. O `PermissionsModule`
 * inteiro traria `repositories`, e um `repositories.groups.create(...)` chamado
 * daqui escaparia do `SECURITY DEFINER`… não: o repositório TAMBÉM usa a
 * função. Mas traria os REPOSITÓRIOS de leitura para dentro de um arquivo de
 * escrita, e a estreiteza é o que mantém a fronteira legível.
 */
export type PanelWriter = Pick<PermissionsModule, 'groups' | 'features'>;

export interface PermissionPanelWriteDeps {
  writer: PanelWriter;
  auth: AuthMiddleware;
  permissions: PermissionMiddleware;
  tenantId?: string;
}

// ── Zod na borda ─────────────────────────────────────────────────────────────

const IdParam = z.object({ id: z.string().uuid() });
const NomeDescricao = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
});
const Motivo = z.string().min(1).max(500);

const CriarGrupo = NomeDescricao;
const AtualizarGrupo = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  // Patch vazio é 400, não 200 silencioso: "salvei nada" e "salvei" têm de ser
  // respostas diferentes.
  .refine((b) => b.name !== undefined || b.description !== undefined, {
    message: 'informe ao menos um campo',
  });

const DefinirCelulas = z.object({
  cellKeys: z.array(z.string().min(3).max(128)).max(500),
  reason: Motivo.nullable().optional(),
});
const ConcederPais = z.object({ country: z.enum(COUNTRY_CODES), reason: Motivo });
const PaisParam = z.object({ id: z.string().uuid(), country: z.enum(COUNTRY_CODES) });
const MembroBody = z.object({ userId: z.string().min(1).max(128) });
const MembroParam = z.object({ id: z.string().uuid(), userId: z.string().min(1).max(128) });
const FeatureParam = z.object({ country: z.enum(COUNTRY_CODES), featureKey: z.string().min(3).max(120) });
const FeatureBody = z.object({ enabled: z.boolean(), config: z.unknown().optional(), reason: Motivo });

function responder<T>(res: Response, rotulo: string, trabalho: () => Promise<T>): void {
  void trabalho()
    .then((corpo) => {
      res.json(corpo ?? { success: true });
    })
    .catch((err: unknown) => {
      // `toPermissionError` traduz o erro do driver (42501, 23514, P0002, 23505)
      // para o vocabulário do domínio — é o que faz a borda não conhecer SQLSTATE.
      // `toPermissionError` devolve `unknown`: ela traduz erro do driver
      // (42501, 23514, P0002, 23505) e DEVOLVE O ORIGINAL quando não reconhece.
      // Por isso o `isPermissionError` de novo — sem ele, erro de rede viraria
      // 500 mascarado de 4xx pelo índice `undefined`.
      const perm = isPermissionError(err) ? err : toPermissionError(err);
      if (isPermissionError(perm)) {
        // Negativa NÃO é ruído: é o sinal de que o gate do banco funcionou. A
        // mensagem ORIGINAL fica aqui, no log, e só aqui.
        logger.warn({ rotulo, code: perm.code, detalhe: perm.message }, '[perm] escrita do painel recusada');
        // ⚠️ O corpo leva MENSAGEM DA CASA, não a do Postgres. Medido pelo gate:
        // no 23505 o `perm.message` é `duplicate key value violates unique
        // constraint "permission_groups_tenant_id_name_key"` — nome de tabela e
        // de constraint indo para o cliente, no mesmo arquivo cujo comentário
        // abaixo promete que a borda não vaza estrutura interna.
        res.status(STATUS_POR_CODIGO[perm.code]).json({
          success: false,
          error: MENSAGEM_POR_CODIGO[perm.code],
          code: perm.code,
        });
        return;
      }
      logger.error({ err, rotulo }, '[perm] falha na escrita do painel');
      res.status(500).json({ success: false, error: `Failed to ${rotulo}` });
    });
}

/** 400 padrão da borda — a mensagem do zod não vaza estrutura interna. */
function invalido(res: Response, o_que: string): void {
  res.status(400).json({ success: false, error: `Invalid ${o_que}` });
}

export function createPermissionPanelWriteRoutes(deps: PermissionPanelWriteDeps): Router {
  const router = Router();
  const perm = deps.permissions.family(ADMIN_PERMISSIONS_FAMILY);
  const tenantId = deps.tenantId ?? ENLITE_TENANT_ID;
  const g = deps.writer.groups;

  const portao: RequestHandler[] = [
    deps.auth.requireStaff(),
    perm.require('permission_management', 'write'),
  ];

  // ── Grupo ──────────────────────────────────────────────────────────────────

  router.post('/permission-groups', ...portao, (req, res) => {
    const body = CriarGrupo.safeParse(req.body);
    if (!body.success) return invalido(res, 'group payload');
    responder(res, 'create group', () =>
      g.create.execute({ tenantId, name: body.data.name, description: body.data.description ?? null }),
    );
  });

  router.patch('/permission-groups/:id', ...portao, (req, res) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'group id');
    const body = AtualizarGrupo.safeParse(req.body);
    if (!body.success) return invalido(res, 'group payload');
    responder(res, 'update group', () =>
      g.update.execute({ tenantId, groupId: params.data.id, ...body.data }),
    );
  });

  // DELETE arquiva, não apaga: a trilha do grupo tem de sobreviver ao grupo.
  router.delete('/permission-groups/:id', ...portao, (req, res) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'group id');
    responder(res, 'archive group', () => g.archive.execute({ tenantId, groupId: params.data.id }));
  });

  // ── Células ────────────────────────────────────────────────────────────────

  // PUT, não PATCH: o conjunto é substituído inteiro, e o diff vira trilha. Um
  // PATCH incremental esconderia a remoção de célula dentro de um "adicionei X".
  router.put('/permission-groups/:id/permissions', ...portao, (req, res) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'group id');
    const body = DefinirCelulas.safeParse(req.body);
    if (!body.success) return invalido(res, 'permissions payload');
    responder(res, 'set group permissions', () =>
      g.setPermissions.execute({
        tenantId,
        groupId: params.data.id,
        cellKeys: body.data.cellKeys,
        reason: body.data.reason ?? null,
      }),
    );
  });

  // ── Países ─────────────────────────────────────────────────────────────────

  router.post('/permission-groups/:id/countries', ...portao, (req, res) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'group id');
    const body = ConcederPais.safeParse(req.body);
    if (!body.success) return invalido(res, 'country payload');
    responder(res, 'grant country', () =>
      g.grantCountry.execute({ tenantId, groupId: params.data.id, country: body.data.country, reason: body.data.reason }),
    );
  });

  router.delete('/permission-groups/:id/countries/:country', ...portao, (req, res) => {
    const params = PaisParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'group id or country');
    responder(res, 'revoke country', () =>
      g.revokeCountry.execute({ tenantId, groupId: params.data.id, country: params.data.country }),
    );
  });

  // ── Membros ────────────────────────────────────────────────────────────────

  router.post('/permission-groups/:id/members', ...portao, (req, res) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'group id');
    const body = MembroBody.safeParse(req.body);
    if (!body.success) return invalido(res, 'member payload');
    responder(res, 'add member', () =>
      g.addMember.execute({ tenantId, groupId: params.data.id, userId: body.data.userId }),
    );
  });

  router.delete('/permission-groups/:id/members/:userId', ...portao, (req, res) => {
    const params = MembroParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'group id or user id');
    responder(res, 'remove member', () =>
      g.removeMember.execute({ tenantId, groupId: params.data.id, userId: params.data.userId }),
    );
  });

  // ── Disponibilidade por país ───────────────────────────────────────────────

  router.put('/country-features/:country/:featureKey', ...portao, (req, res) => {
    const params = FeatureParam.safeParse(req.params);
    if (!params.success) return invalido(res, 'country or feature key');
    const body = FeatureBody.safeParse(req.body);
    if (!body.success) return invalido(res, 'feature payload');
    responder(res, 'set country feature', () =>
      deps.writer.features.set.execute({
        country: params.data.country,
        featureKey: params.data.featureKey,
        enabled: body.data.enabled,
        config: body.data.config ?? null,
        reason: body.data.reason,
      }),
    );
  });

  return router;
}
