/**
 * substituteCover — o GATE do substituto (DX-13.6; spec 069 T206/T209): UMA função, usada pela ausência avulsa
 * (`ItineraryAbsenceUseCase`) e pelo pedido de substituição (`CreateSubstitutionRequestUseCase`, "Elegir quién entra").
 * O pool é o do step final da vacante (`deriveAllocationPoolFromRows` + `canAllocate`, 041 R1) — nenhuma 2ª definição de
 * "Selecionado". O próprio titular da alocação é recusado pelo BANCO (`piab_substituto_e_o_titular`), nunca aqui.
 */
import type { PoolClient } from 'pg';
import type { ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { deriveAllocationPoolFromRows } from './serviceTeamPresentation';
import { canAllocate } from '../domain/itineraryAllocationGate';
import { NotSelectedForServiceError } from './ItineraryAllocationUseCase';

export interface SubstituteApplicationPort {
  findApplicationId(client: PoolClient, workerId: string, vacancyId: string): Promise<string | null>;
}

/**
 * O gate do POOL, sozinho: recusa (`NotSelectedForServiceError`) quem não está em Selecionados ∪ Respuesta Rápida da vaga viva (menos os
 * rejeitados). É o 1º passo de `resolveSubstituteApplicationId` e é o que a PRÉ-VISÃO de conflito roda ANTES de consultar a função DEFINER
 * do banco (D3: candidato fora do pool não pode vazar dia/hora/endereço de outro paciente).
 */
export function assertCandidateInPool(ctx: { patientId: string; serviceId: string; team: ServiceTeamRows; now: Date }, workerId: string): void {
  const { patientId, serviceId, team, now } = ctx;
  if (!canAllocate(deriveAllocationPoolFromRows(team, now), workerId)) {
    throw new NotSelectedForServiceError(patientId, serviceId, workerId);
  }
}

/**
 * A candidatura (vaga viva) do substituto. Recusa (`NotSelectedForServiceError`) quem não está no pool, o serviço sem vaga
 * viva e quem não tem candidatura nela.
 */
export async function resolveSubstituteApplicationId(
  port: SubstituteApplicationPort,
  client: PoolClient,
  ctx: { patientId: string; serviceId: string; team: ServiceTeamRows; now: Date },
  substituteWorkerId: string,
): Promise<string> {
  const { patientId, serviceId, team, now } = ctx;
  assertCandidateInPool(ctx, substituteWorkerId);
  if (team.liveVacancyId === null) throw new NotSelectedForServiceError(patientId, serviceId, substituteWorkerId);

  const applicationId = await port.findApplicationId(client, substituteWorkerId, team.liveVacancyId);
  if (applicationId === null) throw new NotSelectedForServiceError(patientId, serviceId, substituteWorkerId);
  return applicationId;
}
