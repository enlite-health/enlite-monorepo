/**
 * src/modules/identity/infrastructure/mergeCustomClaims.ts
 *
 * ÚNICA forma de escrever custom claims de staff no Identity Platform.
 *
 * `admin.auth().setCustomUserClaims(uid, obj)` SUBSTITUI o objeto inteiro — não
 * faz merge. Os quatro escritores de `role` do backend (criar admin, trocar
 * papel, auto-provisionar no 1º login, trigger onUserCreate) faziam
 * `setCustomUserClaims(uid, { role })` e, sem querer, APAGAVAM o claim `country`
 * da ABAC país (task 3.2). Achado no QA em 16/08: o usuário de gate perdeu
 * `country=AR` no auto-provision do primeiro login e passou a ver zero
 * pacientes (fail-closed correto, causa errada). Em prod, uma troca de papel
 * pelo painel faria o mesmo com qualquer staff.
 *
 * O script `scripts/set-staff-country-claim.ts` já preservava com spread —
 * aqui é o mesmo cuidado, centralizado.
 */

import * as admin from 'firebase-admin';

/** Grava `patch` por cima dos claims atuais do usuário, sem apagar os demais. */
export async function mergeCustomClaims(
  uid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const user = await admin.auth().getUser(uid);
  await admin.auth().setCustomUserClaims(uid, { ...(user.customClaims ?? {}), ...patch });
}
