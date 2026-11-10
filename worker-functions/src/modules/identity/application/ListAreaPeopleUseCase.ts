/**
 * Lista paginada de pessoas da aba "Vínculos de área" e busca por e-mail exato (change aba-vinculos-de-area, T1).
 *
 * - Sem busca, ou busca por e-mail/telefone: paginação no banco (`total` real).
 * - Busca por nome: o nome do prestador é cifrado, então o banco devolve CANDIDATOS por blind index (teto
 *   `WORKER_SEARCH_CANDIDATE_LIMIT`, mesmo helper da lista de prestadores), decifra-se, confere-se e pagina-se em memória.
 * - Só as linhas da PÁGINA são decifradas; só as `account` da página vão ao Firebase (`getUsers` em lote).
 * Nada aqui loga: nome, e-mail e termo de busca são PII.
 */
import type { BlindIndexService } from '@shared/security/BlindIndexService';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  WORKER_SEARCH_CANDIDATE_LIMIT,
  decryptWorkerName,
  matchesSearch,
  nameSearchBidxLiteral,
  planWorkerSearch,
} from '@shared/security/workerNameSearch';
import {
  PEOPLE_MAX_LIMIT,
  PeopleSearchError,
  type FirebaseUserLookup,
  type PeopleDirectoryReader,
  type PeoplePage,
  type PeopleQuery,
  type PeopleSearchFilter,
  type PersonItem,
  type PersonRow,
} from './AreaPeople';

interface NamedRow {
  row: PersonRow;
  firstName: string;
  lastName: string;
}

export class ListAreaPeopleUseCase {
  constructor(
    private readonly directory: PeopleDirectoryReader,
    private readonly kms: Pick<KMSEncryptionService, 'decrypt'>,
    private readonly blindIndex: BlindIndexService,
    private readonly firebase: FirebaseUserLookup,
  ) {}

  async execute(query: PeopleQuery): Promise<PeoplePage> {
    const limit = Math.min(Math.max(query.limit, 1), PEOPLE_MAX_LIMIT);
    const offset = Math.max(query.offset, 0);
    const plan = planWorkerSearch(query.search);
    const base = { type: query.type, withMembership: query.withMembership };

    let pageRows: PersonRow[];
    let named: NamedRow[] | null = null;
    let total: number;

    if (plan?.kind === 'name') {
      const bidx = await nameSearchBidxLiteral(this.blindIndex, plan.raw);
      if (!bidx.ok) throw new PeopleSearchError(bidx.error);
      const candidates = await this.directory.rows({
        ...base,
        search: { kind: 'name', bidxLiteral: bidx.literal },
        mode: { kind: 'candidates', limit: WORKER_SEARCH_CANDIDATE_LIMIT },
      });
      const decrypted = await Promise.all(candidates.rows.map((row) => this.withName(row)));
      const kept = decrypted
        .filter(({ row, firstName, lastName }) =>
          matchesSearch(plan.term, [firstName, lastName, row.displayName ?? '', row.email ?? '', row.phone ?? '']),
        )
        .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime());
      total = kept.length;
      named = kept.slice(offset, offset + limit);
      pageRows = named.map((n) => n.row);
    } else {
      const search: PeopleSearchFilter = plan ? { kind: plan.kind, like: plan.like } : { kind: 'none' };
      const page = await this.directory.rows({ ...base, search, mode: { kind: 'page', limit, offset } });
      pageRows = page.rows;
      total = page.total;
    }

    const items = await this.toItems(pageRows, named ?? (await Promise.all(pageRows.map((row) => this.withName(row)))));
    return { items, total, limit, offset };
  }

  private async withName(row: PersonRow): Promise<NamedRow> {
    const { firstName, lastName } = await decryptWorkerName(this.kms as KMSEncryptionService, {
      first_name_encrypted: row.firstNameEncrypted,
      last_name_encrypted: row.lastNameEncrypted,
    });
    return { row, firstName, lastName };
  }

  private async toItems(rows: PersonRow[], named: NamedRow[]): Promise<PersonItem[]> {
    const accountUids = rows.filter((r) => r.kind === 'account').map((r) => r.uid);
    const [profiles, memberships] = await Promise.all([
      accountUids.length ? this.firebase.getUsers(accountUids) : Promise.resolve(new Map()),
      this.directory.membershipsOf(rows.flatMap((r) => (r.personId ? [r.personId] : []))),
    ]);
    return named.map(({ row, firstName, lastName }) => {
      const profile = profiles.get(row.uid);
      const email = row.email ?? profile?.email ?? '';
      const workerName = [firstName, lastName].filter(Boolean).join(' ');
      return {
        personId: row.personId,
        uid: row.uid,
        displayName: row.displayName || workerName || profile?.displayName || email,
        email,
        kind: row.kind,
        memberships: row.personId ? (memberships.get(row.personId) ?? []) : [],
      };
    });
  }
}
