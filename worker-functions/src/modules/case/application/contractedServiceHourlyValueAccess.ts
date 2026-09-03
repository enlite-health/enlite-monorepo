/**
 * contractedServiceHourlyValueAccess — o ÚNICO ponto que decide se um ator lê `hourlyValue` de um
 * serviço contratado (spec 013, lex C-c.4).
 *
 * `hourly_value` é o preço do CONTRATO cobrado à família/obra social (C-c.2 — não é remuneração
 * do prestador). Leitura restrita a `admin`; `recruiter`/`community_manager` (o resto de
 * `requireStaff`, `AuthMiddleware.ts:250-262`) recebem o campo redigido.
 *
 * Molde LOCAL (não o `NOME_REDIGIDO` de string-sentinela, D181): igual a
 * `patientClinicalAccess.ts` (mesmo módulo, D211.2) — `null` + flag `hourlyValueRedacted: true`.
 * Diferente do caso do D181 (nome de prestador com FALLBACK de campo irmão em texto claro no
 * MESMO objeto), aqui não há campo irmão pro qual `??`/`||` do chamador possa escorregar: o
 * `null` de "redigido" e o `null` de "não informado" são o MESMO sinal de UI ("—"), e o flag
 * distingue os dois casos para quem precisar (ex.: não mostrar "editar valor" a quem não vê).
 *
 * Por papel (hoje) — quando o ABAC F1 ligar célula própria para `hourly_value`, este é o ponto
 * único a trocar (mesmo contrato de `canReadPatientClinical`, fail-open documentado):
 *   - `roles` ausente/null → comportamento de hoje (nunca deveria acontecer: a rota já passou por
 *     requireStaff, então `req.user.roles` sempre existe — o fallback aqui é só defesa).
 *   - `roles` inclui `admin` → lê.
 *   - caso contrário → redige.
 */
import type { Request } from 'express';

export function isAdminActor(roles: readonly string[] | null | undefined): boolean {
  if (roles === null || roles === undefined) return true; // defesa; requireStaff já filtrou
  return roles.includes('admin');
}

/** Lê os papéis que `AuthMiddleware` pendura em `req.user.roles`. */
export function actorRolesOf(req: Request): readonly string[] | null {
  const roles = (req as Request & { user?: { roles?: readonly string[] } }).user?.roles;
  return roles ?? null;
}

/**
 * Projeta um serviço contratado para o ator: `hourlyValue` vira `null` + `hourlyValueRedacted:
 * true` quando o ator não é admin. Devolve o MESMO objeto quando é admin (sem cópia).
 */
export function projectContractedServiceForActor<T extends { hourlyValue: number | null }>(
  service: T,
  roles: readonly string[] | null | undefined,
): T & { hourlyValueRedacted: boolean } {
  if (isAdminActor(roles)) return { ...service, hourlyValueRedacted: false };
  return { ...service, hourlyValue: null, hourlyValueRedacted: true };
}
