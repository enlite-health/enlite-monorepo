/** Repositórios da rotina diária (spec 069 F4): SQL conferido; a execução real é do e2e `069-rotina-diaria`. */
import { ItineraryDailyRunRepository } from '../ItineraryDailyRunRepository';
import { UncoveredAlertDispatchRepository, isAlreadyDispatched } from '../UncoveredAlertDispatchRepository';
import { UncoveredAlertReader } from '../UncoveredAlertReader';

const client = (rows: unknown[] = []) => ({ query: jest.fn().mockResolvedValue({ rows }) });

describe('ItineraryDailyRunRepository', () => {
  it('begin é idempotente (ON CONFLICT DO NOTHING) e finish carimba finished_at + failures só da linha do país/dia', async () => {
    const c = client();
    const repo = new ItineraryDailyRunRepository();
    await repo.begin(c as never, 'AR', '2026-11-02');
    await repo.finish(c as never, 'AR', '2026-11-02', 2);
    expect(c.query.mock.calls[0][0]).toMatch(/INSERT INTO itinerary_daily_run[\s\S]*ON CONFLICT \(country, operation_date\) DO NOTHING/);
    expect(c.query.mock.calls[0][1]).toEqual(['AR', '2026-11-02']);
    expect(c.query.mock.calls[1][0]).toMatch(/SET finished_at = now\(\), failures = \$3 WHERE country = \$1 AND operation_date = \$2::date/);
    expect(c.query.mock.calls[1][1]).toEqual(['AR', '2026-11-02', 2]);
  });

  it('P12: candidatos = país + não deletado + FORA dos estados manuais e do funil + itinerário montado (listas da regra pura)', async () => {
    const c = client([{ id: 'p1' }, { id: 'p2' }]);
    expect(await new ItineraryDailyRunRepository().listDerivationCandidates(c as never, 'AR')).toEqual(['p1', 'p2']);
    const [sql, params] = c.query.mock.calls[0];
    expect(sql).toMatch(/p\.country = \$1 AND p\.deleted_at IS NULL/);
    expect(sql).toMatch(/p\.status <> ALL\(\$2::text\[\]\)/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM patient_itinerary_assembly/);
    expect(params[0]).toBe('AR');
    expect(params[1]).toEqual(expect.arrayContaining(['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED']));
  });
});

describe('UncoveredAlertDispatchRepository', () => {
  it('insertPending grava PENDING (a PK dia × destinatário é a idempotência); listRetryable lê PENDING/FAILED do dia; markEmail atualiza o resultado', async () => {
    const c = client([{ recipient_uid: 'u1' }]);
    const repo = new UncoveredAlertDispatchRepository();
    await repo.insertPending(c as never, { operationDate: '2026-11-02', recipientUid: 'u1', eventId: 'ev' });
    expect(c.query.mock.calls[0][0]).toMatch(/INSERT INTO itinerary_uncovered_alert_dispatch[\s\S]*'PENDING'/);
    expect(c.query.mock.calls[0][0]).not.toMatch(/ON CONFLICT/); // a violação TEM de estourar: é ela que desfaz a transação
    expect(await repo.listRetryable(c as never, '2026-11-02')).toEqual(['u1']);
    expect(c.query.mock.calls[1][0]).toMatch(/email_status IN \('PENDING','FAILED'\)/);
    await repo.markEmail(c as never, { operationDate: '2026-11-02', recipientUid: 'u1', status: 'FAILED', errorCode: 'X' });
    expect(c.query.mock.calls[2][1]).toEqual(['2026-11-02', 'u1', 'FAILED', 'X']);
  });

  it('isAlreadyDispatched: só o código 23505 (e tolera null/undefined)', () => {
    expect(isAlreadyDispatched({ code: '23505' })).toBe(true);
    expect(isAlreadyDispatched({ code: '23503' })).toBe(false);
    expect(isAlreadyDispatched(null)).toBe(false);
    expect(isAlreadyDispatched(undefined)).toBe(false);
  });
});

describe('UncoveredAlertReader', () => {
  it('readLabels: sem pacientes → [] e nenhuma query; com pacientes, nome (paciente → responsável → fallback) e código do serviço ATIVO', async () => {
    const empty = client();
    expect(await new UncoveredAlertReader().readLabels(empty as never, [])).toEqual([]);
    expect(empty.query).not.toHaveBeenCalled();

    const c = client([{ patient_id: 'p1', service_id: 's1', patient_name: 'Ana Gómez', service_code: 'AT' }]);
    expect(await new UncoveredAlertReader().readLabels(c as never, ['p1'])).toEqual([{ patientId: 'p1', serviceId: 's1', patientName: 'Ana Gómez', serviceCode: 'AT' }]);
    const sql = c.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/Paciente sin nombre/);
    expect(sql).toMatch(/patient_responsibles r[\s\S]*r\.is_primary AND r\.active/);
    expect(sql).toMatch(/pcs\.active/);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it('readUniverse: só devolve paciente com fatos (montagem/estado) — deletado sai; as 3 leituras de ocorrência + a de fatos rodam UMA vez', async () => {
    const queries: string[] = [];
    const c = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (/FROM patient_itinerary_slot s/.test(sql)) {
          return { rows: [
            { patient_id: 'p1', slot_id: 'sl1', service_id: 's1', weekday: 1, start_time: '08:00', slot_end: '12:00', valid_range: '[2026-01-01,)' },
            { patient_id: 'p-deletado', slot_id: 'sl2', service_id: 's2', weekday: 1, start_time: '08:00', slot_end: '12:00', valid_range: '[2026-01-01,)' },
          ] };
        }
        if (/FROM patients p\s+WHERE p\.id = ANY/.test(sql)) return { rows: [{ id: 'p1', status: 'ACTIVE', assembled: true }] };
        return { rows: [] };
      }),
    };
    const u = await new UncoveredAlertReader().readUniverse(c as never, 'AR', '2026-11-02');
    expect(u.map((x) => x.patientId)).toEqual(['p1']);
    expect(u[0].facts).toEqual({ itineraryAssembled: true, patientStatus: 'ACTIVE' });
    expect(u[0].inputs.slots).toHaveLength(1);
    expect(queries).toHaveLength(4);
    expect((c.query.mock.calls[0] as unknown[])[1]).toEqual(['AR', '2026-11-02', '2026-11-08']); // janela [hoje, hoje+6]
  });
});
