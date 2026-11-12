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

/** Bootstrap da pessoa (`iam.ensure_person`): cria pessoa + login se não existe; login removido → `null`. */
export interface PersonBootstrap {
  ensurePerson(uid: string): Promise<string | null>;
}

/** O login existe no Firebase? (`false` só para "não existe"; qualquer outra falha lança.) */
export interface LoginVerifier {
  exists(uid: string): Promise<boolean>;
}

export class GrantAreaMembershipUseCase {
  constructor(
    private readonly writer: AreaMembershipWriter,
    private readonly registry: AreaRegistryReader,
    private readonly logins: LoginDirectory,
    private readonly bootstrap?: PersonBootstrap,
    private readonly verifier?: LoginVerifier,
  ) {}

  /**
   * Concede para quem AINDA NÃO virou pessoa (staff/prestador/conta só-Firebase sem bootstrap): `ensure_person` (idempotente)
   * e depois o mesmo `execute`. O login é conferido no Firebase ANTES do `ensure_person` (uid inexistente → recusa sem gravar).
   * A pessoa é criada ANTES da pré-checagem do teto porque o cálculo do claim parte do `pid`;
   * o `ensure_person` é o que todo login já faz no bootstrap, então uma pessoa vazia de uma concessão recusada é inofensiva.
   */
  async executeForUid(input: Omit<GrantAreaMembershipInput, 'pid'> & { uid: string }): Promise<Result<{ membershipId: string } & SyncAreasClaimsResult>> {
    if (!this.bootstrap || !this.verifier) return Result.fail('bootstrap de pessoa não configurado');
    let pid: string | null;
    try {
      // ANTES de criar qualquer coisa: uid que não existe no Firebase não vira `iam.person`/`person_login` (são append-only).
      if (!(await this.verifier.exists(input.uid))) return Result.fail('pessoa inexistente: login não existe no Firebase');
      pid = await this.bootstrap.ensurePerson(input.uid);
    } catch (error) {
      return Result.fail(error instanceof Error ? error.message : 'Failed to ensure person');
    }
    if (!pid) return Result.fail('pessoa inexistente: login removido (conta apagada)');
    return this.execute({ pid, area: input.area, role: input.role, actorUid: input.actorUid });
  }

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
