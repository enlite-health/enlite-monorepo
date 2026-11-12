/**
 * Busca por e-mail EXATO (change aba-vinculos-de-area, T1, decisão 6): Firebase `getUserByEmail` → a mesma forma de item
 * da lista, ou `null` (404). Só leitura: não cria pessoa. Nada aqui loga (o e-mail é PII).
 */
import type { FirebaseUserLookup, PeopleDirectoryReader, PersonItem } from './AreaPeople';

export class FindAreaPersonByEmailUseCase {
  constructor(
    private readonly directory: PeopleDirectoryReader,
    private readonly firebase: FirebaseUserLookup,
  ) {}

  async execute(email: string): Promise<PersonItem | null> {
    const profile = await this.firebase.getByEmail(email);
    if (!profile) return null;
    const { personId, kind } = await this.directory.describeLogin(profile.uid);
    const memberships = personId ? ((await this.directory.membershipsOf([personId])).get(personId) ?? []) : [];
    const mail = profile.email ?? '';
    return { personId, uid: profile.uid, displayName: profile.displayName || mail, email: mail, kind, memberships };
  }
}
