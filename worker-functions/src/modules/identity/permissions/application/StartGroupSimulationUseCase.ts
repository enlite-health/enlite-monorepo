/**
 * src/modules/identity/permissions/application/StartGroupSimulationUseCase.ts
 *
 * Spec 026 (D407) — abre a simulação chamando `GroupSimulationRepository.start`
 * (que desce para `iam.start_group_simulation`, mig 458: 42501 não-Master,
 * P0002 grupo inexistente/arquivado/outro tenant, 23514 alvo=Master — todos já
 * traduzidos pelo `toPermissionError` existente, sem reinterpretar aqui) e
 * publica `PermissionEventPublisher.permissionChanged([uid])` — o MESMO evento
 * que já invalida o cache de 30 s do `PermissionService` (`ports.ts:225-228`).
 * Só o ATOR real: a simulação não muda filiação de ninguém, então nenhum outro
 * uid precisa ter o cache invalidado.
 *
 * TTL: `PERMISSION_SIMULATION_TTL_MINUTES` (default `240`, mesmo molde de
 * `permissionCacheTtlMs`, `PermissionService.ts:44-55` — valor inválido loga
 * warn e cai no default, nunca lança). O repositório espera um literal de
 * INTERVAL do Postgres (`$2::interval`); o formato escolhido é `"<N> minutes"`
 * (`'240 minutes'` no default) — Postgres aceita esse literal sem ambiguidade
 * de plural/singular.
 */

import { logger } from '@shared/logging';
import type { GroupSimulation } from '../domain/GroupSimulation';
import type { GroupSimulationRepository, PermissionEventPublisher } from './ports';

/** Default do rollout (spec.md decisão #4, 22/09/2026: "TTL fica como rede de segurança"). */
export const DEFAULT_PERMISSION_SIMULATION_TTL_MINUTES = 240;

/** TTL do ambiente — mesmo molde de `permissionCacheTtlMs` (`PermissionService.ts:44-55`). */
export function permissionSimulationTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PERMISSION_SIMULATION_TTL_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PERMISSION_SIMULATION_TTL_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn({ raw }, '[perm] PERMISSION_SIMULATION_TTL_MINUTES inválido — usando o default');
    return DEFAULT_PERMISSION_SIMULATION_TTL_MINUTES;
  }
  return parsed;
}

/** `"<N> minutes"` — literal de INTERVAL que `PgGroupSimulationRepository.start` passa como `$2::interval`. */
export function simulationTtlInterval(minutes: number): string {
  return `${minutes} minutes`;
}

export interface StartGroupSimulationInput {
  uid: string;
  tenantId: string;
  groupId: string;
}

export class StartGroupSimulationUseCase {
  constructor(
    private readonly simulations: GroupSimulationRepository,
    private readonly events: PermissionEventPublisher,
    /** Injetável para teste; resolvido do ambiente UMA vez na construção (mesmo molde do `PermissionService`). */
    private readonly ttlMinutes: number = permissionSimulationTtlMinutes(),
  ) {}

  async execute(input: StartGroupSimulationInput): Promise<GroupSimulation> {
    const simulation = await this.simulations.start(
      input.uid,
      input.tenantId,
      input.groupId,
      simulationTtlInterval(this.ttlMinutes),
    );
    await this.events.permissionChanged([input.uid]);
    return simulation;
  }
}
