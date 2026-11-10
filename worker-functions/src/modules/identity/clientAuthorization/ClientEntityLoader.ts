import type { Pool } from 'pg';
import type { AuthContext } from '../domain/Auth';
import { ListPersonAreasUseCase, type AreaRegistryReader } from '../application/ListPersonAreasUseCase';
import type { CedarRequest, ClientEntityProvider } from './CedarClientPolicyEngine';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/** Bootstrap da pessoa do login (mesmo `iam.ensure_person` do `GET /v1/me/areas`). `null` = login removido. */
export interface PersonBootstrap {
  ensurePerson(uid: string): Promise<string | null>;
}

/** O mínimo que o loader precisa além do registro de áreas: raiz da pessoa e dono (raiz) de uma ficha de prestador. */
export interface ClientOwnershipReader {
  /** `iam.person_root(pid)` — a pessoa viva da árvore (login absorvido por merge decide como a sobrevivente). */
  rootOf(pid: string): Promise<string | null>;
  /** Raiz da pessoa do login `workers.auth_uid` da ficha; ficha ou login inexistente → `null`. */
  workerOwnerRoot(workerId: string): Promise<string | null>;
}

export class PgClientOwnershipRepository implements ClientOwnershipReader {
  constructor(private readonly pool: Pool) {}

  async rootOf(pid: string): Promise<string | null> {
    const r = await this.pool.query<{ pid: string | null }>(`SELECT iam.person_root($1::uuid) AS pid`, [pid]);
    return r.rows[0]?.pid ?? null;
  }

  async workerOwnerRoot(workerId: string): Promise<string | null> {
    const r = await this.pool.query<{ pid: string | null }>(
      `SELECT iam.person_root(iam.resolve_person('firebase', w.auth_uid)) AS pid FROM workers w WHERE w.id = $1::uuid`,
      [workerId],
    );
    return r.rows[0]?.pid ?? null;
  }
}

const person = (id: string) => ({ __entity: { type: 'Person', id } });

/**
 * Monta as entidades Cedar do plano do cliente (design §4). O principal é `Person::"<pid>"` — a RAIZ da pessoa do login
 * (`iam.resolve_person` → `iam.person_root`), nunca o uid do token (D647). As áreas (`Person.areas`) vêm do
 * `ListPersonAreasUseCase` — a mesma descoberta do claim, sem consulta duplicada. `Worker.owner` e `Account.owner`
 * são `Person`; a `Account` é montada do TOKEN (uid e dono), nunca de header ou parâmetro. Qualquer falha lança
 * (o engine transforma em deny).
 */
export class ClientEntityLoader implements ClientEntityProvider {
  private readonly areas: ListPersonAreasUseCase;

  constructor(
    private readonly bootstrap: PersonBootstrap,
    registry: AreaRegistryReader,
    private readonly ownership: ClientOwnershipReader,
  ) {
    this.areas = new ListPersonAreasUseCase(registry);
  }

  async load(context: AuthContext, resource: Resource, _action: string): Promise<CedarRequest> {
    const uid = context.principal.id;
    const own = await this.bootstrap.ensurePerson(uid);
    if (!own) throw new Error('login sem pessoa viva');
    const pid = await this.ownership.rootOf(own);
    if (!pid) throw new Error('pessoa sem raiz');

    const listed = await this.areas.execute({
      principal: { roles: context.principal.roles ?? [], accountType: context.principal.accountType },
      pid,
    });
    if (listed.isFailure) throw new Error(listed.error as string);
    const areas = listed.getValue().map((a) => `${a.area}:${a.role}`);

    const entities: unknown[] = [{ uid: { type: 'Person', id: pid }, attrs: { areas }, parents: [] }];

    if (resource.type === 'Account') {
      entities.push({ uid: { type: 'Account', id: uid }, attrs: { owner: person(pid), uid }, parents: [] });
      return { principal: { type: 'Person', id: pid }, resource: { type: 'Account', id: uid }, context: { tokenUid: uid }, entities };
    }
    if (!resource.id) throw new Error('recurso sem id');
    const owner = await this.ownership.workerOwnerRoot(resource.id);
    if (owner) entities.push({ uid: { type: resource.type, id: resource.id }, attrs: { owner: person(owner) }, parents: [] });
    return { principal: { type: 'Person', id: pid }, resource: { type: resource.type, id: resource.id }, entities };
  }
}
