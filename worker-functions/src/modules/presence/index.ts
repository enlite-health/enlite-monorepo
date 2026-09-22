/**
 * presence module — barrel export.
 *
 * External code MUST import only from this file. Boundary rule enforced by ESLint
 * no-restricted-imports (see `.eslint-module-boundaries.js`).
 *
 * Extraído de `@modules/identity` em 22/09/2026 (change 022-ux-mencao-e-notificacao, Rodada 2):
 * presença (heartbeat "visto por último") é reusável fora do staff-directory — o
 * `AdminRepository.searchStaffDirectory` (identity) só faz o LEFT JOIN de LEITURA sobre
 * `staff_presence`; a ESCRITA (heartbeat) vive inteira aqui.
 */

// ─── Infrastructure ───────────────────────────────────────────────────────────
export { PresenceRepository } from './infrastructure/PresenceRepository';

// ─── Application ──────────────────────────────────────────────────────────────
export { UpdatePresenceUseCase } from './application/UpdatePresenceUseCase';

// ─── Interfaces ───────────────────────────────────────────────────────────────
export { AdminPresenceController } from './interfaces/controllers/AdminPresenceController';
export { createAdminPresenceRoutes } from './interfaces/routes/adminPresenceRoutes';
