/**
 * Descoberta única das áreas da pessoa (spec area-registry, design §3, DF-12, DF-21).
 *
 * A entrada é o `pid` (a pessoa do login) MAIS o principal do login:
 *   - `backoffice`·`staff` vem do LOGIN, pela MESMA função do portão (`isStaffAccount`, V1 → A ajustada, 09/11):
 *     um dono só (D514). NÃO é consultado por árvore: login B sem staff, em árvore onde outro login é staff, não ganha painel.
 *   - `care`·`worker` é derivado da ÁRVORE da pessoa (`workers.auth_uid` ∈ `iam.person_login_uids(pid)`).
 *   - `care`·`family` e `learn`·* vêm do registro (`iam.effective_area_memberships`), também pela árvore.
 * As três fontes se SOMAM sem duplicar; a ordem é estável (backoffice, care, clinic, learn; papel alfabético).
 */
import { Result } from '@shared/utils/Result';
import { isStaffAccount, type AccountTyped } from '../domain/AccountType';
import { AREA_ORDER, entryRouteFor } from '../domain/areaEntryRoutes';

export interface StoredMembership {
  area: string;
  role: string;
}

/** Porta de leitura do registro, por `pid`. Implementada por `PgAreaRegistryRepository`. */
export interface AreaRegistryReader {
  /** Algum login vivo da árvore da pessoa opera uma ficha em `workers`. */
  hasWorkerInTree(pid: string): Promise<boolean>;
  /** Vínculos gravados vivos da árvore (`iam.effective_area_memberships`). */
  storedMemberships(pid: string): Promise<StoredMembership[]>;
}

export interface PersonArea {
  area: string;
  role: string;
  entryRoute: string | null;
}

export interface ListPersonAreasInput {
  /** O principal do login que fez a chamada (`req.user`), o mesmo que o portão de staff avalia. */
  principal: AccountTyped;
  pid: string;
}

function orderOf(area: string): number {
  const i = (AREA_ORDER as readonly string[]).indexOf(area);
  return i === -1 ? AREA_ORDER.length : i;
}

export class ListPersonAreasUseCase {
  constructor(private readonly registry: AreaRegistryReader) {}

  async execute(input: ListPersonAreasInput): Promise<Result<PersonArea[]>> {
    try {
      const pairs: StoredMembership[] = [];
      if (isStaffAccount(input.principal)) pairs.push({ area: 'backoffice', role: 'staff' });
      if (await this.registry.hasWorkerInTree(input.pid)) pairs.push({ area: 'care', role: 'worker' });
      pairs.push(...(await this.registry.storedMemberships(input.pid)));

      const seen = new Set<string>();
      const areas = pairs
        .filter((p) => {
          const key = `${p.area}:${p.role}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => orderOf(a.area) - orderOf(b.area) || a.role.localeCompare(b.role))
        .map((p) => ({ area: p.area, role: p.role, entryRoute: entryRouteFor(p.area, p.role) }));
      return Result.ok(areas);
    } catch (error) {
      return Result.fail(error instanceof Error ? error.message : 'Failed to list person areas');
    }
  }
}
