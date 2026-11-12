/**
 * Revoga um vínculo gravado (`iam.revoke_area_membership`), recalcula `areas`+`pid` INTEIROS e chama
 * `revokeRefreshTokens` em cada login vivo da pessoa (a revogação precisa valer já, não em 1h).
 */
import { Result } from '@shared/utils/Result';
import type { AreaRegistryReader } from './ListPersonAreasUseCase';
import type { AreaMembershipWriter } from './GrantAreaMembershipUseCase';
import { syncAreasClaims, type LoginDirectory, type SyncAreasClaimsResult } from '../infrastructure/areasClaim';

export interface RevokeAreaMembershipInput {
  pid: string;
  area: string;
  role: string;
  actorUid: string;
  reason: string;
}

export class RevokeAreaMembershipUseCase {
  constructor(
    private readonly writer: AreaMembershipWriter,
    private readonly registry: AreaRegistryReader,
    private readonly logins: LoginDirectory,
  ) {}

  async execute(input: RevokeAreaMembershipInput): Promise<Result<{ revoked: number } & SyncAreasClaimsResult>> {
    let revoked: number;
    try {
      revoked = await this.writer.revoke(input.pid, input.area, input.role, input.actorUid, input.reason);
    } catch (error) {
      return Result.fail(error instanceof Error ? error.message : 'Failed to revoke area membership');
    }
    const synced = await syncAreasClaims(input.pid, this.registry, this.logins, { revokeTokens: true });
    if (synced.isFailure) return Result.fail(synced.error as string);
    return Result.ok({ revoked, ...synced.getValue() });
  }
}
