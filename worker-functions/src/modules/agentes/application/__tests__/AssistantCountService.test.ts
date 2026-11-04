import { AssistantCountService, CountReaderPort, RawCountResult } from '../AssistantCountService';
import { COUNT_MENU } from '../../domain/assistantCountMenu';

const ACTOR = { source: 'admin_panel', id: 'staff:u1' } as const;

function build(result: RawCountResult) {
  const reader = { count: jest.fn(async (..._a: Parameters<CountReaderPort['count']>) => result) };
  const readers = { workers: reader, patients: reader, vacancies: reader };
  const run = jest.fn(async (_actor: unknown, fn: (r: typeof readers) => Promise<unknown>) => fn(readers));
  return { svc: new AssistantCountService(run as never), reader, run };
}

describe('AssistantCountService', () => {
  it('materializa zeros: grupo ausente vira 0 exato, não {lt}', async () => {
    const { svc } = build({ total: 12, groups: [{ key: 'REGISTERED', value: 12 }] });
    const r = await svc.count('workers', { group_by: 'registration' }, ACTOR, ['AR']);
    if (!r.ok) throw new Error('esperava ok');
    const byKey = Object.fromEntries(r.response.groups.map((g) => [g.key, g]));
    expect(Object.keys(byKey).sort()).toEqual([...COUNT_MENU.workers.fields.registration.values].sort());
    expect(byKey.DISABLED).toEqual({ key: 'DISABLED', value: 0 });
    expect(byKey.REGISTERED).toEqual({ key: 'REGISTERED', value: 12 });
    expect(r.response.total).toEqual({ value: 12 });
  });

  it('filtro no MESMO campo do group_by restringe os valores materializados', async () => {
    const { svc } = build({ total: 0, groups: [] });
    const r = await svc.count('workers', { filters: [{ field: 'registration', values: ['REGISTERED'] }], group_by: 'registration' }, ACTOR, ['AR']);
    if (!r.ok) throw new Error('esperava ok');
    expect(r.response.groups).toEqual([{ key: 'REGISTERED', value: 0 }]);
  });

  it('restricted_to_admission aparece no scope em espanhol', async () => {
    const { svc } = build({ total: 7, restricted_to_admission: true });
    const r = await svc.count('patients', { filters: [{ field: 'incomplete_registration', values: ['true'] }] }, ACTOR, ['AR']);
    if (!r.ok) throw new Error('esperava ok');
    expect(r.response.scope).toContain('solo en admisión');
    expect(r.response.scope).toContain(COUNT_MENU.patients.scope_es);
  });

  it('grupo de 3 sai {lt:5} e o total sai {gte}', async () => {
    const { svc } = build({ total: 37, groups: [{ key: 'REGISTERED', value: 34 }, { key: 'DISABLED', value: 3 }] });
    const r = await svc.count('workers', { group_by: 'registration' }, ACTOR, ['AR']);
    if (!r.ok) throw new Error('esperava ok');
    expect(r.response.groups.find((g) => g.key === 'DISABLED')).toEqual({ key: 'DISABLED', lt: 5 });
    expect(r.response.total).toEqual({ gte: 30 });
  });

  it('campo inválido: 400 com valid_fields e o leitor NÃO é chamado', async () => {
    const { svc, reader, run } = build({ total: 1 });
    const r = await svc.count('workers', { filters: [{ field: 'nombre', values: ['x'] }] }, ACTOR, ['AR']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toMatchObject({ code: 'invalid_field', valid_fields: Object.keys(COUNT_MENU.workers.fields) });
    expect(reader.count).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('zona em prestadores declara a sobreposição; ALTA literal declara "incluye altas"', async () => {
    const w = await build({ total: 10, groups: [] }).svc.count('workers', { group_by: 'zone' }, ACTOR, ['AR']);
    if (!w.ok) throw new Error('esperava ok');
    expect(w.response.scope).toContain('cuenta en cada una');
    const p = await build({ total: 10 }).svc.count('patients', { filters: [{ field: 'stage', values: ['ALTA'] }] }, ACTOR, ['AR']);
    if (!p.ok) throw new Error('esperava ok');
    expect(p.response.scope).toContain('incluye altas');
  });

  it('a resposta não tem chave fora do shape (sem id/nome/linha) e passa ator e países ao leitor', async () => {
    const { svc, reader, run } = build({ total: 6, groups: [{ key: 'true', value: 6 }], ...({ id: 'x', name: 'y' } as object) } as RawCountResult);
    const r = await svc.count('vacancies', { group_by: 'has_applicant' }, ACTOR, ['AR', 'BR']);
    if (!r.ok) throw new Error('esperava ok');
    expect(Object.keys(r.response).sort()).toEqual(['as_of', 'entity', 'filters', 'group_by', 'groups', 'scope', 'total']);
    expect(JSON.stringify(r.response)).not.toMatch(/"id"|"name"/);
    expect(run.mock.calls[0][0]).toBe(ACTOR);
    expect(reader.count.mock.calls[0][1]).toEqual(['AR', 'BR']);
  });
});
