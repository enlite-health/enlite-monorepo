import type { Pool } from 'pg';
import { EnquadreEventGlobalList, type EnquadreGlobalListInput } from '../EnquadreEventGlobalList';
import type { EnquadreListRow } from '../../infrastructure/EnquadreEventListRepository';

jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (client: unknown) => Promise<unknown>) => fn({}),
}));

// Fuso ≠ Buenos Aires para o BR: com São Paulo (-03) o teste passaria por coincidência (Buenos Aires também é -03).
jest.mock('../../domain/admissionCountries', () => {
  const actual = jest.requireActual('../../domain/admissionCountries');
  return {
    ...actual,
    getAdmissionCountryConfig: (country: 'AR' | 'BR') => ({
      ...actual.getAdmissionCountryConfig(country),
      timezone: country === 'BR' ? 'Etc/GMT-5' : 'America/Argentina/Buenos_Aires',
    }),
  };
});

const INPUT: EnquadreGlobalListInput = {
  countries: ['AR', 'BR'],
  from: null,
  to: null,
  statuses: null,
  host: null,
  q: null,
  limit: 20,
  offset: 0,
};

function row(over: Partial<EnquadreListRow> = {}): EnquadreListRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    job_posting_id: '00000000-0000-4000-8000-0000000000aa',
    country: 'AR',
    host_display_name: 'Entrevistadora Ficticia 01',
    starts_at: new Date('2026-10-28T17:00:00Z'),
    ends_at: new Date('2026-10-28T18:00:00Z'),
    status: 'open',
    import_status: null,
    blocked_reason: null,
    event_code: 'ENC-AB12CD',
    case_number: 960001,
    case_ordinal: 2,
    convoked: 7,
    total: 1,
    convoked_total: 7,
    range_from: '2026-10-26',
    range_to: '2026-11-01',
    hosts: ['Entrevistadora Ficticia 01'],
    ...over,
  };
}

function build(rows: EnquadreListRow[], now = new Date('2026-10-27T12:00:00Z')) {
  const list = jest.fn().mockResolvedValue(rows);
  const uc = new EnquadreEventGlobalList({ db: {} as Pool, repo: { list }, now: () => now });
  return { uc, list };
}

describe('EnquadreEventGlobalList', () => {
  it('evento AR sai com o offset de Buenos Aires e o BR com o do fuso do PAÍS (Etc/GMT-5), não o de AR', async () => {
    const { uc } = build([
      row(),
      row({ id: '00000000-0000-4000-8000-000000000002', country: 'BR' }),
    ]);
    const out = await uc.execute(INPUT);
    expect(out.items[0].startsAt).toBe('2026-10-28T14:00:00-03:00');
    expect(out.items[1].startsAt).toBe('2026-10-28T22:00:00+05:00');
    expect(out.items[1].endsAt).toBe('2026-10-28T23:00:00+05:00');
  });

  it('import blocked sem blocked_reason → importBlocked null; com motivo → { reason }', async () => {
    const { uc } = build([
      row({ import_status: 'blocked', blocked_reason: null }),
      row({ id: '00000000-0000-4000-8000-000000000003', import_status: 'blocked', blocked_reason: 'meet_scope_missing' }),
      row({ id: '00000000-0000-4000-8000-000000000004', import_status: 'done', blocked_reason: null }),
    ]);
    const out = await uc.execute(INPUT);
    expect(out.items.map((i) => i.importBlocked)).toEqual([null, { reason: 'meet_scope_missing' }, null]);
  });

  it('o item não carrega nome, e-mail nem telefone: só as chaves da lista fechada', async () => {
    const { uc } = build([row()]);
    const out = await uc.execute(INPUT);
    expect(Object.keys(out.items[0]).sort()).toEqual(
      [
        'caseNumber',
        'caseOrdinal',
        'convokedCount',
        'country',
        'endsAt',
        'eventCode',
        'hostName',
        'id',
        'importBlocked',
        'jobPostingId',
        'phase',
        'startsAt',
        'status',
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toMatch(/host_email|email|phone|telefono|telefone/i);
  });

  it('fase vem do relógio: aberto depois do fim = pending_close; encerrado = closed', async () => {
    const { uc } = build(
      [row(), row({ id: '00000000-0000-4000-8000-000000000005', status: 'closed' })],
      new Date('2026-10-29T00:00:00Z'),
    );
    const out = await uc.execute(INPUT);
    expect(out.items.map((i) => i.phase)).toEqual(['pending_close', 'closed']);
  });

  it('página vazia (colunas da página NULL) → sem itens, mas com totais e período', async () => {
    const empty = row({
      id: null, job_posting_id: null, country: null, host_display_name: null, starts_at: null, ends_at: null,
      status: null, event_code: null, case_number: null, case_ordinal: null, convoked: null,
      total: 25, convoked_total: 150, hosts: [],
    });
    const { uc } = build([empty]);
    const out = await uc.execute({ ...INPUT, offset: 100 });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(25);
    expect(out.convokedTotal).toBe(150);
    expect(out.range).toEqual({ from: '2026-10-26', to: '2026-11-01', defaulted: true });
  });

  it('range.defaulted só quando o cliente não mandou datas', async () => {
    const { uc } = build([row()]);
    const out = await uc.execute({ ...INPUT, from: '2026-10-01', to: '2026-10-31' });
    expect(out.range.defaulted).toBe(false);
  });

  it('a busca vira padrão ILIKE só de código/dígitos/ordinal; nome nunca chega ao repositório', async () => {
    const { uc, list } = build([row()]);
    await uc.execute({ ...INPUT, q: 'EN1234#02' });
    expect(list.mock.calls[0][1]).toMatchObject({ eventCodeLike: null, digitsLike: '%1234%', ordinal: 2 });
    await uc.execute({ ...INPUT, q: 'enc-ab12' });
    expect(list.mock.calls[1][1]).toMatchObject({ eventCodeLike: '%ENC-AB12%', digitsLike: null, ordinal: null });
    await uc.execute({ ...INPUT, q: 'Ficticio 01' });
    expect(list.mock.calls[2][1]).toMatchObject({ eventCodeLike: null, digitsLike: null, ordinal: null });
  });
});
