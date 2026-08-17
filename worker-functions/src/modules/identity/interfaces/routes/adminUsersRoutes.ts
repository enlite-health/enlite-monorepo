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
 * ⚠️ `PATCH /:id/role` exige `permission_management:write`, NÃO `user_management:write`:
 * mexer no papel de alguém é mexer em ACESSO, e é a fronteira que o lex C1
 * (acesso urgente, ≥2 gestores nomeados) protege.
 *
 * As rotas guardam o `requireAdmin`/`requireStaff` de hoje ALÉM da célula, de
 * propósito: enquanto a família não está em `PERMISSION_ENFORCED_ROUTES`, o
 * guard de papel é a única proteção; depois da virada, os dois valem e o mais
 * restritivo ganha. Tirar o papel agora seria abrir a rota no intervalo.
 */

import { Router } from 'express';
import type { AdminController } from '../controllers/AdminController';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../middleware/PermissionMiddleware';

export const ADMIN_USERS_FAMILY = 'admin.users';

export function createAdminUsersRoutes(
  controller: AdminController,
  auth: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.post('/users', auth.requireAdmin(), perm.require('user_management', 'write'), (req, res) => {
    controller.createAdminUser(req, res);
  });

  router.get('/users', auth.requireStaff(), perm.require('user_management', 'read'), (req, res) => {
    controller.listAdminUsers(req, res);
  });

  // ⚠️ ANTES de `/users/:id` — `by-email` casaria com `:id` e o DELETE por
  // e-mail viraria "apagar o usuário de id 'by-email'". A ordem é contrato.
  router.delete('/users/by-email', auth.requireAdmin(), perm.require('user_management', 'delete'), (req, res) => {
    controller.deleteUserByEmail(req, res);
  });

  router.delete('/users/:id', auth.requireAdmin(), perm.require('user_management', 'delete'), (req, res) => {
    controller.deleteAdminUser(req, res);
  });

  router.post(
    '/users/:id/reset-password',
    auth.requireAdmin(),
    perm.require('user_management', 'write'),
    (req, res) => {
      controller.resetAdminPassword(req, res);
    },
  );

  router.patch(
    '/users/:id/role',
    auth.requireAdmin(),
    perm.require('permission_management', 'write'),
    (req, res) => {
      controller.updateAdminRole(req, res);
    },
  );

  return router;
}
