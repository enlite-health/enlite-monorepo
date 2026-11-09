/** Concede um vínculo gravado (`iam.grant_area_membership`) e recalcula `areas`+`pid` em cada login vivo da pessoa. */
import { Result } from '@shared/utils/Result';
import { isStoredAreaRole } from '../domain/Area';
import type { AreaRegistryReader } from './ListPersonAreasUseCase';
import { syncAreasClaims, type LoginDirectory, type SyncAreasClaimsResult } from '../infrastructure/areasClaim';

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
    let membershipId: string;
    try {
      membershipId = await this.writer.grant(input.pid, input.area, input.role, input.actorUid);
    } catch (error) {
      return Result.fail(error instanceof Error ? error.message : 'Failed to grant area membership');
    }
    const synced = await syncAreasClaims(input.pid, this.registry, this.logins, { revokeTokens: false });
    if (synced.isFailure) return Result.fail(synced.error as string);
    return Result.ok({ membershipId, ...synced.getValue() });
  }
}
