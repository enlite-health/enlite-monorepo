import { ListAreaPeopleUseCase } from '../ListAreaPeopleUseCase';
import { FindAreaPersonByEmailUseCase } from '../FindAreaPersonByEmailUseCase';
import { PeopleSearchError, type PeopleDirectoryReader, type PersonRow, type PeopleRowsQuery } from '../AreaPeople';
import { BlindIndexService } from '@shared/security/BlindIndexService';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const PID = '00000000-0000-4000-8000-000000000001';

function row(p: Partial<PersonRow> & { uid: string }): PersonRow {
  return {
    personId: null, kind: 'staff', email: `${p.uid}@ejemplo.com`, displayName: null, firstNameEncrypted: null,
    lastNameEncrypted: null, phone: null, createdAt: new Date('2026-01-01'), ...p,
  };
}

function setup(rows: PersonRow[], total = rows.length) {
  const calls: PeopleRowsQuery[] = [];
  const directory: PeopleDirectoryReader = {
    rows: async (q) => (calls.push(q), { rows, total }),
    describeLogin: async () => ({ personId: PID, kind: 'account' }),
    membershipsOf: async (ids) => new Map(ids.map((id) => [id, [{ id: 'm1', area: 'learn', role: 'learner' }]])),
  };
  const getUsers = jest.fn(async (uids: string[]) => new Map(uids.map((uid) => [uid, { uid, displayName: 'Cuenta Ejemplo', email: `${uid}@ejemplo.com` }])));
  const firebase = { getUsers, getByEmail: jest.fn(async (email: string) => (email === 'a@ejemplo.com' ? { uid: 'u-a', displayName: null, email } : null)) };
  const kms = { decrypt: async (c: string | null | undefined) => (c ? Buffer.from(c, 'base64').toString('utf8') : '') };
  return { calls, firebase, getUsers, uc: new ListAreaPeopleUseCase(directory, kms, new BlindIndexService(), firebase), directory };
}

describe('ListAreaPeopleUseCase', () => {
  it('sem busca: pagina no banco, devolve o `total` do banco e corta o limite em 100', async () => {
    const { uc, calls } = setup([row({ uid: 'a' }), row({ uid: 'b' })], 237);
    const r = await uc.execute({ type: 'all', limit: 500, offset: 40 });
    expect(r).toMatchObject({ total: 237, limit: 100, offset: 40 });
    expect(calls[0].mode).toEqual({ kind: 'page', limit: 100, offset: 40 });
    expect((await uc.execute({ type: 'all', limit: 0, offset: 0 })).limit).toBe(1);
  });

  it('só as linhas `account` da página vão ao Firebase; nome de prestador é decifrado; vínculos vêm por pessoa', async () => {
    const { uc, getUsers } = setup([
      row({ uid: 'w1', kind: 'worker', firstNameEncrypted: b64('Ana'), lastNameEncrypted: b64('Prueba'), personId: PID }),
      row({ uid: 'acc', kind: 'account', email: null, personId: PID }),
    ]);
    const r = await uc.execute({ type: 'all', limit: 20, offset: 0 });
    expect(getUsers).toHaveBeenCalledTimes(1);
    expect(getUsers).toHaveBeenCalledWith(['acc']);
    expect(r.items[0]).toMatchObject({ uid: 'w1', displayName: 'Ana Prueba', kind: 'worker' });
    expect(r.items[1]).toMatchObject({ uid: 'acc', displayName: 'Cuenta Ejemplo', email: 'acc@ejemplo.com', kind: 'account' });
    expect(r.items[1].memberships).toEqual([{ id: 'm1', area: 'learn', role: 'learner' }]);
  });

  it('nenhuma linha `account` → Firebase não é chamado', async () => {
    const { uc, getUsers } = setup([row({ uid: 'a' })]);
    await uc.execute({ type: 'all', limit: 20, offset: 0 });
    expect(getUsers).not.toHaveBeenCalled();
  });

  it('busca por nome: candidatos com teto 200, confere de verdade e pagina em memória (total = conferidos)', async () => {
    const cand = [
      row({ uid: 'w1', email: 'w1@otro.test', kind: 'worker', firstNameEncrypted: b64('Zoe'), lastNameEncrypted: b64('Ejemplo'), createdAt: new Date('2026-03-01') }),
      row({ uid: 'w2', email: 'w2@otro.test', kind: 'worker', firstNameEncrypted: b64('Zoe'), lastNameEncrypted: b64('Otra'), createdAt: new Date('2026-02-01') }),
      row({ uid: 'w3', email: 'w3@otro.test', kind: 'worker', firstNameEncrypted: b64('Zoe'), lastNameEncrypted: b64('Ejemplo'), createdAt: new Date('2026-01-01') }),
    ];
    const { uc, calls } = setup(cand);
    const r = await uc.execute({ search: 'zoe ejemplo', type: 'all', limit: 1, offset: 1 });
    expect(calls[0].mode).toEqual({ kind: 'candidates', limit: 200 });
    expect(calls[0].search.kind).toBe('name');
    expect(r.total).toBe(2);
    expect(r.items.map((i) => i.uid)).toEqual(['w3']);
  });

  it('busca por nome curta demais → PeopleSearchError (400) sem consultar o banco', async () => {
    const { uc, calls } = setup([]);
    await expect(uc.execute({ search: 'ab', type: 'all', limit: 20, offset: 0 })).rejects.toBeInstanceOf(PeopleSearchError);
    expect(calls).toHaveLength(0);
  });

  it('e-mail/telefone vão ao banco paginados (sem conferir em memória)', async () => {
    const { uc, calls } = setup([row({ uid: 'a' })], 1);
    await uc.execute({ search: 'a@ejemplo.com', type: 'staff', limit: 20, offset: 0 });
    expect(calls[0].search).toEqual({ kind: 'email', like: '%a@ejemplo.com%' });
    expect(calls[0].mode.kind).toBe('page');
  });
});

describe('FindAreaPersonByEmailUseCase', () => {
  it('acha pelo Firebase e devolve a forma de item; sem usuário → null', async () => {
    const { firebase, directory } = setup([]);
    const uc = new FindAreaPersonByEmailUseCase(directory, firebase);
    expect(await uc.execute('a@ejemplo.com')).toEqual({
      personId: PID, uid: 'u-a', displayName: 'a@ejemplo.com', email: 'a@ejemplo.com', kind: 'account',
      memberships: [{ id: 'm1', area: 'learn', role: 'learner' }],
    });
    expect(await uc.execute('x@ejemplo.com')).toBeNull();
  });
});
