/**
 * contractedServiceHourlyValueAccess — o ÚNICO ponto que decide se um ator lê `hourlyValue` de um
 * serviço contratado (spec 013, lex C-c.4).
 *
 * `hourly_value` é o preço do CONTRATO cobrado à família/obra social (C-c.2 — não é remuneração
 * do prestador). É DADO, e dado tem célula (D286): `patient_contract_value:read`. A célula não é
 * portão de rota (a rota abre com `patient_services:read`; só o PREÇO depende dela) — por isso é
 * declarada em `CELL_DESCRIPTION`, a segunda fonte do catálogo (`cellsForaDeRota`).
 *
 * Molde LOCAL (não o `NOME_REDIGIDO` de string-sentinela, D181): igual a
 * `patientClinicalAccess.ts` (mesmo módulo, D211.2) — `null` + flag `hourlyValueRedacted: true`.
 * Diferente do caso do D181 (nome de prestador com FALLBACK de campo irmão em texto claro no
 * MESMO objeto), aqui não há campo irmão pro qual `??`/`||` do chamador possa escorregar: o
 * `null` de "redigido" e o `null` de "não informado" são o MESMO sinal de UI ("—"), e o flag
 * distingue os dois casos para quem precisar (ex.: não mostrar "editar valor" a quem não vê).
 *
 * Decisão (07/09/2026 — o papel deixou de ser nível de acesso):
 *   - `cells` é lista (o engine decidiu nesta request) → lê SÓ com a célula. `[]` redige.
 *   - `cells === null` (engine não decidiu — família fora do enforcement, D113) → o que a rota
 *     devolvia antes: papel `admin` lê, o resto é redigido. É o mesmo `untilEnforced` do
 *     `PermissionMiddleware`, aqui no nível do campo — fail-open para `null` seria mostrar o
 *     preço a toda recrutadora no `main` com o engine desligado. Quando toda família virar em
 *     produção, `roles` sai daqui junto com a coluna.
 */
import type { Request } from 'express';
import { clinicalCellsOf } from './patientClinicalAccess';

export const PATIENT_CONTRACT_VALUE_READ_CELL = 'patient_contract_value:read';

/** O que a decisão precisa do ator: as células (se o engine decidiu) e o papel (fallback). */
export interface HourlyValueActor {
  cells: readonly string[] | null;
  roles: readonly string[] | null;
}

function isAdminRole(roles: readonly string[] | null | undefined): boolean {
  if (roles === null || roles === undefined) return true; // defesa; requireStaff já filtrou
  return roles.includes('admin');
}

export function canReadHourlyValue(actor: HourlyValueActor): boolean {
  if (actor.cells !== null) return actor.cells.includes(PATIENT_CONTRACT_VALUE_READ_CELL);
  return isAdminRole(actor.roles);
}

/** Lê o que `AuthMiddleware` (papel) e `PermissionMiddleware` (células) penduram na request. */
export function hourlyValueActorOf(req: Request): HourlyValueActor {
  const roles = (req as Request & { user?: { roles?: readonly string[] } }).user?.roles;
  return { cells: clinicalCellsOf(req), roles: roles ?? null };
}

/**
 * Projeta um serviço contratado para o ator: `hourlyValue` vira `null` + `hourlyValueRedacted:
 * true` quando o ator não lê o preço. Devolve o MESMO objeto quando lê (sem cópia).
 */
export function projectContractedServiceForActor<T extends { hourlyValue: number | null }>(
  service: T,
  actor: HourlyValueActor,
): T & { hourlyValueRedacted: boolean } {
  if (canReadHourlyValue(actor)) return { ...service, hourlyValueRedacted: false };
  return { ...service, hourlyValue: null, hourlyValueRedacted: true };
}

/**
 * A chave `hourlyValue` está PRESENTE no corpo da requisição?
 *
 * Pela CHAVE, não pelo valor: `hourlyValue: null` é ESCRITA (apaga o preço do contrato). Quem não
 * pode LER o campo não pode escrevê-lo — é a mesma régua que `AdminPatientsController` aplica a
 * `emergencyInstructions` e `onHoldNote` (patientClinicalAccess), e o que
 * `ContractedServiceFormRow` já faz na tela ao mandar `undefined` quando o campo vem redigido.
 */
export function bodyWritesHourlyValue(body: unknown): boolean {
  return typeof body === 'object' && body !== null && Object.prototype.hasOwnProperty.call(body, 'hourlyValue');
}
