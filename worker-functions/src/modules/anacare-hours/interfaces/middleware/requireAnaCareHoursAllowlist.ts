/**
 * src/modules/anacare-hours/interfaces/middleware/requireAnaCareHoursAllowlist.ts
 *
 * Porte PRD (`feat/anacare-horas-prd-allowlist`): substitui o gate ABAC (`perm.require('anacare_hours', ...)`,
 * só existe na stage) por allowlist estática de e-mail, aplicada individualmente nas 5 rotas do
 * módulo — DEPOIS de `authMiddleware.requireStaff()` na mesma cadeia (nunca sozinho: sem staff
 * autenticado não há uid pra resolver e-mail).
 *
 * E-mail: nunca de header enviado pelo cliente. `AuthMiddleware.getAuthContext(req)?.principal.id`
 * é o firebase_uid do TOKEN JÁ VERIFICADO por `requireStaff()`; a partir dele, resolve o e-mail
 * pela nossa própria tabela `users` — mesmo padrão de `AdminRepository.findByFirebaseUid` usado em
 * `GetAdminProfileUseCase`/`getRoleFromDB` (reuso, não SQL novo). O `Principal` do identity module
 * não carrega e-mail (só `id`/`roles`) — não dá pra ler o e-mail sem essa consulta.
 */

import { Request, Response, NextFunction } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { AdminRepository } from '@modules/identity/infrastructure/AdminRepository';
import { isAnaCareHoursAllowedEmail } from '@shared/security/anaCareHoursAllowlist';

function deny(res: Response): void {
  res.status(403).json({ success: false, error: 'not_allowlisted', code: 'ANACARE_HOURS_NOT_ALLOWLISTED' });
}

export function requireAnaCareHoursAllowlist(adminRepo: Pick<AdminRepository, 'findByFirebaseUid'> = new AdminRepository()) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!uid) {
      deny(res);
      return;
    }

    // Erro de banco não pode deixar a requisição pendurada (sem next() nem resposta) — achado do
    // gate revisao-pr (critério 7, 15/09): fail-closed tem que ser uma resposta explícita, nunca
    // uma promise rejeitada sem tratamento.
    try {
      const admin = await adminRepo.findByFirebaseUid(uid);
      if (!isAnaCareHoursAllowedEmail(admin?.email)) {
        deny(res);
        return;
      }
      next();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'requireAnaCareHoursAllowlist' });
      deny(res);
    }
  };
}
