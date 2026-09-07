/**
 * src/modules/identity/interfaces/routes/adminUsersRoutes.ts
 *
 * A família `admin.users` — a PRIMEIRA a virar para a decisão real por célula
 * (design 6: `admin.users` + `admin.permissions` primeiro, porque é a tela que
 * o próprio gestor usa para conceder acesso; virar outra antes deixaria o
 * operador sem como consertar o que acabasse de trancar).
 *
 * Estava inline no `src/index.ts` (6 rotas) e virou router por dois motivos
 * concretos, não por estética: (a) o `index.ts` já passa do teto de 400 linhas,
 * e (b) inline não dá para varrer num teste — o `index.ts` monta a app com
 * efeito colateral (pools, `listen`), então nada consegue importá-lo para
 * conferir que toda rota declara célula. Como router, a família é escaneável em
 * teste unitário (`adminUsersRoutes.test.ts`).
 *
 * Mapa rota→célula: `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 *
 * 07/09/2026 — o papel (`users.role`) deixou de ser nível de acesso: a célula
 * decide, e o painel não mostra nem edita papel (o `PATCH /:id/role` foi
 * removido — acesso se concede por grupo em `/admin/access`). `requireStaff()`
 * fica porque é a fronteira staff × prestador, não um nível. O que a rota
 * exigia antes (`admin`) vai em `untilEnforced` e só vale enquanto a família
 * não está em `PERMISSION_ENFORCED_ROUTES` — tirar sem isso abriria a rota no
 * `main` com o engine desligado.
 */

import { Router } from 'express';
import type { AdminController } from '../controllers/AdminController';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../middleware/PermissionMiddleware';

import { ADMIN_USERS_FAMILY } from '@modules/identity/permissions';
export { ADMIN_USERS_FAMILY };

export function createAdminUsersRoutes(
  controller: AdminController,
  auth: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.post('/users', auth.requireStaff(), perm.require('user_management', 'write', { untilEnforced: 'admin' }), (req, res) => {
    controller.createAdminUser(req, res);
  });

  router.get('/users', auth.requireStaff(), perm.require('user_management', 'read'), (req, res) => {
    controller.listAdminUsers(req, res);
  });

  // ⚠️ ANTES de `/users/:id` — `by-email` casaria com `:id` e o DELETE por
  // e-mail viraria "apagar o usuário de id 'by-email'". A ordem é contrato.
  router.delete('/users/by-email', auth.requireStaff(), perm.require('user_management', 'delete', { untilEnforced: 'admin' }), (req, res) => {
    controller.deleteUserByEmail(req, res);
  });

  router.delete('/users/:id', auth.requireStaff(), perm.require('user_management', 'delete', { untilEnforced: 'admin' }), (req, res) => {
    controller.deleteAdminUser(req, res);
  });

  router.post(
    '/users/:id/reset-password',
    auth.requireStaff(),
    perm.require('user_management', 'write', { untilEnforced: 'admin' }),
    (req, res) => {
      controller.resetAdminPassword(req, res);
    },
  );

  return router;
}
