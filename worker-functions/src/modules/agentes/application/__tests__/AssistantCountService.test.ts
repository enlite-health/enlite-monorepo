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
    // DISABLED é excluído pelo recorte padrão e não foi nomeado: ausente (0 ali significaria "não medido")
    expect(Object.keys(byKey).sort()).toEqual(['INCOMPLETE_REGISTER', 'REGISTERED']);
    expect(byKey.DISABLED).toBeUndefined();
    expect(byKey.REGISTERED).toEqual({ key: 'REGISTERED', value: 12 });
    expect(r.response.total).toEqual({ value: 12 });
  });

  it('valor excluído pelo recorte e NOMEADO literalmente aparece (com 0 se não houver); DISCHARGED idem em stage', async () => {
    const w = await build({ total: 0, groups: [] }).svc.count('workers', { filters: [{ field: 'registration', values: ['DISABLED'] }], group_by: 'registration' }, ACTOR, ['AR']);
    if (!w.ok) throw new Error('esperava ok');
    expect(w.response.groups).toEqual([{ key: 'DISABLED', value: 0 }]);
    const sem = await build({ total: 4, groups: [{ key: 'ACTIVE', value: 4 }] }).svc.count('patients', { group_by: 'stage' }, ACTOR, ['AR']);
    if (!sem.ok) throw new Error('esperava ok');
    expect(sem.response.groups.map((g) => g.key)).not.toContain('DISCHARGED');
    expect(sem.response.groups.map((g) => g.key)).toContain('ALTA');
    const com = await build({ total: 0, groups: [] }).svc.count('patients', { filters: [{ field: 'stage', values: ['DISCHARGED'] }], group_by: 'stage' }, ACTOR, ['AR']);
    if (!com.ok) throw new Error('esperava ok');
    expect(com.response.groups).toEqual([{ key: 'DISCHARGED', value: 0 }]);
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

  it('stage restrito ao recorte de admissão: zero só para etapas medidas (sem ACTIVE/ALTA/SOLICITANTE)', async () => {
    const { svc } = build({ total: 7, groups: [{ key: 'ADMISSION', value: 7 }], restricted_to_admission: true });
    const r = await svc.count('patients', { filters: [{ field: 'incomplete_registration', values: ['true'] }], group_by: 'stage' }, ACTOR, ['AR']);
    if (!r.ok) throw new Error('esperava ok');
    const keys = r.response.groups.map((g) => g.key).sort();
    expect(keys).toEqual(['ADMISSION', 'PENDING_ADMISSION']);
    expect(keys).not.toContain('ACTIVE');
    expect(keys).not.toContain('ALTA');
    expect(keys).not.toContain('SOLICITANTE');
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

  it('zona em prestadores declara a sobreposição; DISCHARGED literal declara "incluye bajas"', async () => {
    const w = await build({ total: 10, groups: [] }).svc.count('workers', { group_by: 'zone' }, ACTOR, ['AR']);
    if (!w.ok) throw new Error('esperava ok');
    expect(w.response.scope).toContain('cuenta en cada una');
    const p = await build({ total: 10 }).svc.count('patients', { filters: [{ field: 'stage', values: ['DISCHARGED'] }] }, ACTOR, ['AR']);
    if (!p.ok) throw new Error('esperava ok');
    expect(p.response.scope).toContain('incluye bajas');
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
