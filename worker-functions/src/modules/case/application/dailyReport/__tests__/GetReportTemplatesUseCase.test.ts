import { GetReportTemplatesUseCase, InvalidTemplateWindowError } from '../GetReportTemplatesUseCase';
import { AccountInactiveError } from '../../GetWorkerItineraryUseCase';
import { fakePort, fakeState, guard, version, OTHER_SERVICE } from './fakeDailyReport';

const ARGS = { uid: 'uid-1', from: '2026-11-15', to: '2026-11-20', today: '2026-11-17' };

describe('GetReportTemplatesUseCase — molde por guarda (DC-2, DC-4, L3)', () => {
  it('guarda com PTI vigente: objetivos com pergunta (sem OM, sem legado), atividades (sem escala vira SN, sem OM) e prazo = fim + 24 h', async () => {
    const s = fakeState({ versions: [version('v1', { objectiveIds: ['o-aut', 'o-sn', 'o-legado', 'o-om'], activityIds: ['a-sn', 'a-legado', 'a-om'] })] });
    const { items } = await new GetReportTemplatesUseCase(fakePort(s)).execute(ARGS);
    expect(items).toHaveLength(1);
    expect(items[0].occurrenceId).toBe('occ-1');
    expect(items[0].ptiVersionId).toBe('v1');
    expect(items[0].dueAt).toBe('2026-11-17T15:00:00.000Z');
    expect(items[0].objectives.map((o) => [o.id, o.scaleCode])).toEqual([['o-aut', 'AUT'], ['o-sn', 'SN']]);
    expect(items[0].activities.map((a) => [a.id, a.scaleCode])).toEqual([['a-sn', 'SN'], ['a-legado', 'SN']]);
  });

  it('DC-4: sem PTI vigente para o serviço da guarda → ptiVersionId null e listas vazias (só relatório); PTI de OUTRO serviço não vale', async () => {
    const s = fakeState({ versions: [version('v-outro', { contractedServiceId: OTHER_SERVICE })] });
    const { items } = await new GetReportTemplatesUseCase(fakePort(s)).execute(ARGS);
    expect(items[0]).toMatchObject({ ptiVersionId: null, objectives: [], activities: [] });
  });

  it('só as guardas dentro de [from, to]; o PTI é lido uma vez por serviço (2 guardas, 1 leitura)', async () => {
    let reads = 0;
    const s = fakeState({
      guards: [guard({ occurrenceId: 'a', onDate: '2026-11-16' }), guard({ occurrenceId: 'b', onDate: '2026-11-18' }), guard({ occurrenceId: 'fora', onDate: '2026-11-30' })],
    });
    const port = fakePort(s);
    const original = port.run.bind(port);
    const counting: typeof port = { run: (work) => original((tx) => work({ ...tx, projectVersionsOfService: async (id) => { reads += 1; return tx.projectVersionsOfService(id); } })) };
    const { items } = await new GetReportTemplatesUseCase(counting).execute(ARGS);
    expect(items.map((i) => i.occurrenceId)).toEqual(['a', 'b']);
    expect(reads).toBe(1);
  });

  it('janela inválida (from > to, ou mais de 9 dias) → InvalidTemplateWindowError; exatamente 9 dias passa', async () => {
    const uc = new GetReportTemplatesUseCase(fakePort(fakeState()));
    await expect(uc.execute({ ...ARGS, from: '2026-11-20', to: '2026-11-15' })).rejects.toBeInstanceOf(InvalidTemplateWindowError);
    await expect(uc.execute({ ...ARGS, from: '2026-11-10', to: '2026-11-19' })).rejects.toBeInstanceOf(InvalidTemplateWindowError);
    await expect(uc.execute({ ...ARGS, from: '2026-11-10', to: '2026-11-18' })).resolves.toHaveProperty('items');
  });

  it('conta inexistente/DISABLED → AccountInactiveError', async () => {
    await expect(new GetReportTemplatesUseCase(fakePort(fakeState({ worker: null }))).execute(ARGS)).rejects.toBeInstanceOf(AccountInactiveError);
  });
});
