/**
 * Tipos e portas da lista de pessoas da aba "Vínculos de área" (change aba-vinculos-de-area, T1).
 *
 * Uma linha por PESSOA RAIZ (árvore de merge de `iam.person`); `kind` por prioridade staff > worker > account.
 * Pessoa que ainda não virou `iam.person` (staff/prestador que nunca fez bootstrap) aparece com `personId: null`:
 * o conceder por `uid` (`ensure_person`) é o caminho dela.
 */
export type PersonKind = 'staff' | 'worker' | 'account';
export type PeopleTypeFilter = 'all' | PersonKind;

export const PEOPLE_DEFAULT_LIMIT = 20;
export const PEOPLE_MAX_LIMIT = 100;

export interface PersonMembership {
  id: string;
  area: string;
  role: string;
}

export interface PersonItem {
  personId: string | null;
  uid: string;
  displayName: string;
  email: string;
  kind: PersonKind;
  memberships: PersonMembership[];
}

export interface PeoplePage {
  items: PersonItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface PeopleQuery {
  search?: string;
  type: PeopleTypeFilter;
  withMembership?: boolean;
  limit: number;
  offset: number;
}

/** Linha crua do diretório: nome de prestador ainda CIFRADO (só as linhas da página são decifradas). */
export interface PersonRow {
  personId: string | null;
  uid: string;
  kind: PersonKind;
  email: string | null;
  displayName: string | null;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
  phone: string | null;
  createdAt: Date;
}

export type PeopleSearchFilter =
  | { kind: 'none' }
  | { kind: 'email' | 'phone'; like: string }
  | { kind: 'name'; bidxLiteral: string };

export interface PeopleRowsQuery {
  search: PeopleSearchFilter;
  type: PeopleTypeFilter;
  withMembership?: boolean;
  /** `page` = LIMIT/OFFSET no banco; `candidates` = conjunto com teto para conferir em memória (busca por nome). */
  mode: { kind: 'page'; limit: number; offset: number } | { kind: 'candidates'; limit: number };
}

export interface PeopleDirectoryReader {
  rows(query: PeopleRowsQuery): Promise<{ rows: PersonRow[]; total: number }>;
  /** Pessoa raiz e `kind` de UM login (rota por e-mail exato). */
  describeLogin(uid: string): Promise<{ personId: string | null; kind: PersonKind }>;
  /** Vínculos VIVOS por pessoa raiz (uma consulta para a página inteira). */
  membershipsOf(personIds: string[]): Promise<Map<string, PersonMembership[]>>;
}

export interface FirebaseProfile {
  uid: string;
  displayName: string | null;
  email: string | null;
}

export interface FirebaseUserLookup {
  /** Em lote (≤100 uids por chamada do Firebase); uid inexistente simplesmente não volta. */
  getUsers(uids: string[]): Promise<Map<string, FirebaseProfile>>;
  /** `null` = nenhum usuário com esse e-mail. */
  getByEmail(email: string): Promise<FirebaseProfile | null>;
}

/** Busca por nome inválida (termo curto demais) → 400. */
export class PeopleSearchError extends Error {}
/** O Firebase falhou → 502. A mensagem NUNCA carrega e-mail, nome nem termo. */
export class FirebaseLookupError extends Error {
  constructor() {
    super('Falha ao consultar o Firebase');
  }
}
