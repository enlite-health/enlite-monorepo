/** Concede um vínculo gravado (`iam.grant_area_membership`) e recalcula `areas`+`pid` em cada login vivo da pessoa. */
import { Result } from '@shared/utils/Result';
import { isStoredAreaRole } from '../domain/Area';
import type { AreaRegistryReader } from './ListPersonAreasUseCase';
import { planAreasClaims, applyAreasClaims, type LoginDirectory, type SyncAreasClaimsResult } from '../infrastructure/areasClaim';

export interface AreaMembershipWriter {
  grant(pid: string, area: string, role: string, actorUid: string): Promise<string>;
  revoke(pid: string, area: string, role: string, actorUid: string, reason: string): Promise<number>;
}

export interface GrantAreaMembershipInput {
  pid: string;
  area: string;
  role: string;
  actorUid: string;
}

export class GrantAreaMembershipUseCase {
  constructor(
    private readonly writer: AreaMembershipWriter,
    private readonly registry: AreaRegistryReader,
    private readonly logins: LoginDirectory,
  ) {}

  async execute(input: GrantAreaMembershipInput): Promise<Result<{ membershipId: string } & SyncAreasClaimsResult>> {
    if (!isStoredAreaRole(input.area, input.role)) {
      return Result.fail(`par (${input.area}, ${input.role}) não é gravável no registro`);
    }
    // Pré-checa o teto de 1000 bytes ANTES de gravar no banco: estouro recusa sem gravar NADA.
    const planned = await planAreasClaims(input.pid, this.registry, this.logins, [{ area: input.area, role: input.role }]);
    if (planned.isFailure) return Result.fail(planned.error as string);
    let membershipId: string;
    try {
      membershipId = await this.writer.grant(input.pid, input.area, input.role, input.actorUid);
    } catch (error) {
      return Result.fail(error instanceof Error ? error.message : 'Failed to grant area membership');
    }
    const { uids, plan } = planned.getValue();
    return Result.ok({ membershipId, ...(await applyAreasClaims(uids, plan, { revokeTokens: false })) });
  }
}
