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
import { projectLiveVacancyForActor } from './contractedServiceVacancyAccess';
import { canReadPatientContainer } from './patientContainerAccess';
import type { PayerHistoryItem, PayerCoverageMatch, Payer } from '../infrastructure/contractedServicePayerRead';
import type { PriceState } from '../infrastructure/contractedServicePriceRead';

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
 * Spec 058 §0 (D-34, D-54): o preço do contrato agora vem do TERMO (`price`), e a redação dele é UMA função — `redactTermForActor` —
 * chamada em exatamente 2 lugares: `projectContractedServiceForActor` (preço do serviço) e o handler da lista de contratos
 * (`AdminInsuranceContractsController`, `currentTerm.price`). Os leitores (§T/§G/§P) não recebem o ator.
 * Só o valor `OK` é redigido: `NO_CONTRACT`/`NO_TERM` são o portão `patient_services:read` (o vínculo existe ou não) e passam. O IMPOSTO não é redigido.
 */
export type RedactedPrice = { state: 'REDACTED' };

export function redactTermForActor<P extends { state: string }>(price: P, actor: HourlyValueActor): P | RedactedPrice {
  if (price.state !== 'OK' || canReadHourlyValue(actor)) return price;
  return { state: 'REDACTED' };
}

/** `coverage` decide quem é o pagador e o tipo dele (§0 decisor 2): mesma regra do container `coverage` da ficha; `cells === null` lê (como o container). */
export function canReadPayerNames(actor: HourlyValueActor): boolean {
  return canReadPatientContainer(actor.cells, 'coverage');
}

/** O que a projeção exige do serviço montado (ficha e rota produzem exatamente isto). */
export interface ProjectableService {
  liveVacancy: unknown;
  payer: Payer;
  payerHistory: PayerHistoryItem[];
  price: PriceState;
  coverageMatch: PayerCoverageMatch;
}

type Projected<T extends ProjectableService> = Omit<T, 'price' | 'coverageMatch'> & {
  price: PriceState | RedactedPrice;
  coverageMatch: { state: PayerCoverageMatch['state'] | 'REDACTED' };
  liveVacancyRedacted: boolean;
};

/**
 * Projeta um serviço contratado para o ator, as redações na MESMA passada:
 *   - `price`: `OK` vira `{ state: 'REDACTED' }` quando o ator não lê o preço (`redactTermForActor`); `tax` sai cru;
 *   - `payer.names` (inclui `payerKind`) e `payerHistory[].names` viram `null`, e `coverageMatch` vira `REDACTED`, quando o ator não lê o
 *     container `coverage`; `payer.state`, `isPrivate` e a vigência continuam visíveis (decisor 1);
 *   - `liveVacancy` vira `null` + `liveVacancyRedacted: true` quando o ator não lê vagas (`contractedServiceVacancyAccess`, spec 047).
 * Quem lê tudo recebe os valores crus. `hourlyValue`/`hourlyValueRedacted` não existem mais.
 */
export function projectContractedServiceForActor<T extends ProjectableService>(service: T, actor: HourlyValueActor): Projected<T> {
  const withVacancy = projectLiveVacancyForActor(service, actor);
  const price = redactTermForActor(service.price, actor);
  if (canReadPayerNames(actor)) return { ...withVacancy, price } as unknown as Projected<T>;
  const payer: Payer = service.payer.state === 'LINKED' ? { ...service.payer, names: null } : service.payer;
  const payerHistory = service.payerHistory.map((h) => ({ ...h, names: null }));
  return { ...withVacancy, price, payer, payerHistory, coverageMatch: { state: 'REDACTED' } } as unknown as Projected<T>;
}
