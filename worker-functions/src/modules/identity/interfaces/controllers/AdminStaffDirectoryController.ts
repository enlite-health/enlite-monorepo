/**
 * AdminStaffDirectoryController — GET /api/admin/staff-directory?q=&limit=
 * (spec 022, T128; `contracts/openapi-staff-directory.md`; `limit`/`isOnline` — change
 * 022-ux-mencao-e-notificacao, Rodada 2/R2-B).
 *
 * Alimenta o autocomplete de menção (`<@uid>`) do chat interno sobre um
 * paciente. NÃO é uma API de diretório de pessoal: a resposta é
 * `{ uid, displayName, isOnline }[]` — NUNCA `email` nem `role` nem `last_seen_at` cru (D-06,
 * explícito no contrato — vazar campo aqui é defeito de privacidade, não detalhe; `isOnline` é o
 * único derivado exposto, `last_seen_at` em si nunca sai da resposta).
 *
 * `excludeUid` (R2-B, popup estilo ClickUp: "sem o próprio usuário na lista"): o requester nunca
 * aparece na própria lista de mencionáveis — resolvido por `principalUid` (a MESMA extração que
 * `PermissionMiddleware`/`GET /v1/me/authz` usam, `interfaces/middleware/PermissionMiddleware.ts`
 * — import RELATIVO dentro do próprio módulo `identity`, nunca cruzando para
 * `@modules/conversation`: `ConversationActor.ts` importa `AuthMiddleware` de `@modules/identity`,
 * então importar dali PARA DENTRO de `identity` fecharia um ciclo de módulo). `staffOnly` já
 * garantiu que o principal existe antes deste controller rodar — `null` aqui é defesa em
 * profundidade, nunca esperado na prática.
 *
 * `patientId` (R3-1, change 022-ux-mencao-e-notificacao, Rodada 3, pedido do Gabriel 22/09): só
 * chega ao repositório quando a família `admin.patients` está ENFORCED —
 * `isPermissionFamilyEnforced`, o MESMO predicado que `PermissionClientActorAccessChecker` usa
 * para decidir se o acesso à conversa é uma decisão real do ABAC ou "todo staff pode" (engine
 * desligado/família fora do rollout). Sem isso, filtrar candidatos por uma célula que a rota REAL
 * da conversa nem está checando deixaria o `@` MAIS restritivo que o acesso de verdade —
 * exatamente o inverso do achado F24 que criou `isPermissionFamilyEnforced`.
 */
import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminRepository } from '../../infrastructure/AdminRepository';
import {
  staffDirectoryQuerySchema,
  MIN_STAFF_DIRECTORY_QUERY_LENGTH,
  MAX_STAFF_DIRECTORY_RESULTS,
} from '../validators/staffDirectorySchema';
import { principalUid } from '../middleware/PermissionMiddleware';
import { ADMIN_PATIENTS_FAMILY, isPermissionFamilyEnforced } from '@modules/identity/permissions';

export class AdminStaffDirectoryController {
  constructor(private readonly adminRepo: AdminRepository = new AdminRepository()) {}

  /** GET /api/admin/staff-directory */
  async search(req: Request, res: Response): Promise<void> {
    const query = staffDirectoryQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query',
        details: { fields: Object.keys(query.error.flatten().fieldErrors), minQueryLength: MIN_STAFF_DIRECTORY_QUERY_LENGTH },
      });
      return;
    }

    const uid = principalUid(req);
    if (!uid) {
      res.status(401).json({ success: false, error: 'Not authenticated', code: 'MISSING_ACTOR' });
      return;
    }

    try {
      const limit = query.data.limit ?? MAX_STAFF_DIRECTORY_RESULTS;
      const patientId = isPermissionFamilyEnforced(ADMIN_PATIENTS_FAMILY, process.env)
        ? query.data.patientId
        : undefined;
      const entries = await this.adminRepo.searchStaffDirectory(query.data.q, limit, uid, patientId);
      // Forma explícita — mesmo que o repositório devolva mais campos amanhã, a resposta NUNCA
      // reflete o row inteiro por conta própria (defesa contra um SELECT * futuro).
      res.status(200).json({
        success: true,
        data: entries.map((e) => ({ uid: e.uid, displayName: e.displayName, isOnline: e.isOnline })),
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminStaffDirectoryController:search' });
      res.status(500).json({ success: false, error: 'Failed to search staff directory' });
    }
  }
}
