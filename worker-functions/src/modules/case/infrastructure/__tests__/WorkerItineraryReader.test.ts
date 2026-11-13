/**
 * WorkerItineraryReader — spec 077 F1 (T272): ocorrências do worker na janela, ponto degradado a ~20 m e qualidade.
 * Cliente `pg` falso que devolve o universo cru (3 consultas + pacientes); a expansão e o recorte por worker rodam de verdade.
 * Todos os dados são sintéticos (nenhuma coordenada ou endereço real).
 */
import { v5 as uuidv5 } from 'uuid';
import { degradePoint20m, GRID_DEG, OCCURRENCE_ID_NAMESPACE, readWorkerWindow, windowStart } from '../WorkerItineraryReader';
import { weekdayOfDateString } from '../../domain/itineraryEvents';
import { patientRefOf } from '../../domain/patientRef';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const PAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SLOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ASG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TODAY = '2026-11-02'; // segunda; janela [2026-10-01, 2026-11-16]
const MONDAY = weekdayOfDateString('2026-11-09');

interface Fixture {
  assignments?: Array<Record<string, unknown>>;
  absences?: Array<Record<string, unknown>>;
  patient?: Record<string, unknown>;
}

function fakeClient(f: Fixture = {}) {
  const query = jest.fn(async (sql: string) => {
    const q = String(sql);
    if (q.includes('s.valid::text AS valid_range'))
      return { rows: [{ patient_id: PAT, slot_id: SLOT, service_id: 'svc-1', weekday: MONDAY, start_time: '08:00', slot_end: '16:00', valid_range: '[2026-01-01,)' }] };
    if (q.includes('AS assignment_id, a.slot_id'))
      return {
        rows: f.assignments ?? [
          { patient_id: PAT, assignment_id: ASG, slot_id: SLOT, worker_id: W1, valid_from: '2026-01-01', valid_to: null, status: 'ACTIVE' },
        ],
      };
    if (q.includes('ab.substitute_worker_id, ab.request_id')) return { rows: f.absences ?? [] };
    if (q.includes('LEFT JOIN LATERAL'))
      return {
        rows: [
          { id: PAT, first_name: 'Paciente', country: 'AR', lat: null, lng: null, geocode_quality: null, geocode_partial_match: null, neighborhood: null, ...f.patient },
        ],
      };
    throw new Error(`consulta inesperada: ${q.slice(0, 60)}`);
  });
  return { query };
}

const run = (f: Fixture, workerId = W1) => readWorkerWindow(fakeClient(f) as never, { workerId, today: TODAY });
const dates = (e: Awaited<ReturnType<typeof run>>) => e.items.map((i) => i.on_date);
const absence = (onDate: string, substitute: string | null) => ({
  patient_id: PAT, absence_id: `abs-${onDate}`, assignment_id: ASG, on_date: onDate, substitute_worker_id: substitute, request_id: null,
});

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('readWorkerWindow', () => {
  it('janela [dia 1 do mês anterior, hoje+14]: 7 segundas, 14 chaves exatas, horário local → ISO UTC, envelope full sem tombstone', async () => {
    const env = await run({});
    expect(dates(env)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
    expect(Object.keys(env.items[0]).sort()).toEqual(
      ['address', 'assignment_id', 'country', 'ends_at', 'kind', 'neighborhood', 'occurrence_id', 'on_date', 'patient_first_name', 'patient_point', 'patient_ref', 'seq', 'slot_id', 'starts_at'].sort(),
    );
    expect(env.items[0]).toMatchObject({ slot_id: SLOT, assignment_id: ASG, kind: 'REGULAR', starts_at: '2026-10-05T11:00:00Z', ends_at: '2026-10-05T19:00:00Z', country: 'AR', patient_first_name: 'Paciente', patient_point: null, patient_ref: patientRefOf(PAT), neighborhood: null, address: null });
    expect(env.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(env).toMatchObject({ worker_id: W1, tombstones: [], full: true });
    expect(Buffer.from(env.cursor, 'base64url').toString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('o escopo é por worker (EXISTS alocação / substituto), com params [worker, from, to], sem texto de endereço além do bairro', async () => {
    const client = fakeClient({});
    await readWorkerWindow(client as never, { workerId: W1, today: TODAY });
    const calls = client.query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls).toHaveLength(4);
    for (const [sql] of calls.slice(0, 3)) {
      expect(sql).toMatch(/wa\.worker_id = \$1::uuid/);
      expect(sql).toMatch(/wab\.substitute_worker_id = \$1::uuid/);
    }
    expect(calls[0][1]).toEqual([W1, '2026-10-01', '2026-11-16']);
    const patientSql = calls[3][0];
    expect(patientSql).toMatch(/a\.is_default AND a\.archived_at IS NULL/);
    expect(patientSql).not.toMatch(/address_formatted|address_raw|locality|access_notes|logistics_corridor|address_type|address_summary/);
    expect(patientSql).toContain('COALESCE(pa.neighborhood, p.zone_neighborhood) AS neighborhood');
  });

  it('ausência do worker sem substituto → a ocorrência SOME (sem tombstone)', async () => {
    const env = await run({ absences: [absence('2026-11-09', null)] });
    expect(dates(env)).not.toContain('2026-11-09');
    expect(env.items).toHaveLength(6);
    expect(env.tombstones).toEqual([]);
  });

  it('alocação ENDED → some', async () => {
    const env = await run({ assignments: [{ patient_id: PAT, assignment_id: ASG, slot_id: SLOT, worker_id: W1, valid_from: '2026-01-01', valid_to: null, status: 'ENDED' }] });
    expect(env.items).toEqual([]);
  });

  it('alocação encerrada antes da janela / só depois dela → fora da janela some', async () => {
    const antes = await run({ assignments: [{ patient_id: PAT, assignment_id: ASG, slot_id: SLOT, worker_id: W1, valid_from: '2026-01-01', valid_to: '2026-10-04', status: 'ACTIVE' }] });
    expect(antes.items).toEqual([]);
    const depois = await run({ assignments: [{ patient_id: PAT, assignment_id: ASG, slot_id: SLOT, worker_id: W1, valid_from: '2026-11-17', valid_to: null, status: 'ACTIVE' }] });
    expect(depois.items).toEqual([]);
  });

  it('substituída por outro: some para o substituído; o substituto vê SUBSTITUTION só nesse dia', async () => {
    const f = { absences: [absence('2026-11-09', W2)] };
    const titular = await run(f, W1);
    expect(dates(titular)).not.toContain('2026-11-09');
    expect(titular.items).toHaveLength(6);
    const substituto = await run(f, W2);
    expect(substituto.items).toHaveLength(1);
    expect(substituto.items[0]).toMatchObject({ on_date: '2026-11-09', kind: 'SUBSTITUTION', assignment_id: ASG, slot_id: SLOT });
  });

  it('worker B nunca vê as ocorrências de A', async () => {
    const env = await run({}, W2);
    expect(env.items).toEqual([]);
    expect(env.worker_id).toBe(W2);
  });

  it('occurrence_id = uuid v5 de "slot|data|worker": estável entre chamadas e diferente por worker', async () => {
    const a = await run({});
    const b = await run({});
    expect(a.items.map((i) => i.occurrence_id)).toEqual(b.items.map((i) => i.occurrence_id));
    expect(a.items[0].occurrence_id).toBe(uuidv5(`${SLOT}|2026-10-05|${W1}`, OCCURRENCE_ID_NAMESPACE));
    const substituto = await run({ absences: [absence('2026-11-09', W2)] }, W2);
    const idW1 = uuidv5(`${SLOT}|2026-11-09|${W1}`, OCCURRENCE_ID_NAMESPACE);
    expect(substituto.items[0].occurrence_id).toBe(uuidv5(`${SLOT}|2026-11-09|${W2}`, OCCURRENCE_ID_NAMESPACE));
    expect(substituto.items[0].occurrence_id).not.toBe(idW1);
  });

  it('quality: ROOFTOP sem partial_match = RELIABLE; partial_match, APPROXIMATE e NULL = UNRELIABLE', async () => {
    const q = async (geocode_quality: string | null, geocode_partial_match: boolean | null) =>
      (await run({ patient: { lat: '1.5', lng: '2.5', geocode_quality, geocode_partial_match } })).items[0].patient_point?.quality;
    expect(await q('ROOFTOP', false)).toBe('RELIABLE');
    expect(await q('RANGE_INTERPOLATED', null)).toBe('RELIABLE');
    expect(await q('ROOFTOP', true)).toBe('UNRELIABLE');
    expect(await q('APPROXIMATE', false)).toBe('UNRELIABLE');
    expect(await q(null, null)).toBe('UNRELIABLE');
  });

  it('teste de 20 m: ponto devolvido a ≤ 20 m do real, diferente do real, determinístico, e o real não vaza no JSON', async () => {
    const reais = [
      { lat: 10.123456, lng: 20.654321 },
      { lat: -23.456789, lng: -46.123457 },
      { lat: 47.654321, lng: -12.345678 },
    ];
    for (const real of reais) {
      const f = { patient: { lat: String(real.lat), lng: String(real.lng), geocode_quality: 'ROOFTOP', geocode_partial_match: false } };
      const env = await run(f);
      const again = await run(f);
      const got = env.items[0].patient_point!;
      expect(haversineM(got, real)).toBeLessThanOrEqual(20);
      expect(got.lat).not.toBe(real.lat);
      expect(got.lng).not.toBe(real.lng);
      expect(again.items[0].patient_point).toEqual(got);
      const json = JSON.stringify(env);
      expect(json).not.toContain(String(real.lat));
      expect(json).not.toContain(String(real.lng));
      expect(json).not.toContain('address_summary');
    }
  });

  it('degradePoint20m: múltiplo da grade com 5 casas', () => {
    expect(GRID_DEG).toBe(0.00018);
    expect(degradePoint20m(0.0002, -0.0005)).toEqual({ lat: 0.00018, lng: -0.00054 });
  });

  it('T-F2a-02 patient_ref = patientRefOf(patient_id), estável entre pulls, e o patient_id não aparece no JSON', async () => {
    const a = await run({});
    const b = await run({});
    expect(a.items[0].patient_ref).toBe(patientRefOf(PAT));
    expect(a.items.map((i) => i.patient_ref)).toEqual(b.items.map((i) => i.patient_ref));
    expect(JSON.stringify(a)).not.toContain(PAT);
  });

  it('T-F2a-02 neighborhood vem da coluna lida (null quando falta); address sempre null; as duas chaves sempre presentes', async () => {
    const com = await run({ patient: { neighborhood: 'Palermo' } });
    expect(com.items[0]).toMatchObject({ neighborhood: 'Palermo', address: null });
    const sem = await run({ patient: { neighborhood: undefined } });
    expect(sem.items[0].neighborhood).toBeNull();
    expect(Object.keys(sem.items[0])).toEqual(expect.arrayContaining(['neighborhood', 'address', 'patient_ref']));
  });

  it('T-F2a-02 dois pacientes com o mesmo primeiro nome → dois patient_ref distintos', async () => {
    const PAT2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const SLOT2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const ASG2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const pats = [
      { p: PAT, s: SLOT, a: ASG },
      { p: PAT2, s: SLOT2, a: ASG2 },
    ];
    const query = jest.fn(async (sql: string) => {
      const q = String(sql);
      if (q.includes('s.valid::text AS valid_range'))
        return { rows: pats.map((x, i) => ({ patient_id: x.p, slot_id: x.s, service_id: `svc-${i}`, weekday: MONDAY, start_time: '08:00', slot_end: '16:00', valid_range: '[2026-01-01,)' })) };
      if (q.includes('AS assignment_id, a.slot_id'))
        return { rows: pats.map((x) => ({ patient_id: x.p, assignment_id: x.a, slot_id: x.s, worker_id: W1, valid_from: '2026-01-01', valid_to: null, status: 'ACTIVE' })) };
      if (q.includes('ab.substitute_worker_id, ab.request_id')) return { rows: [] };
      if (q.includes('LEFT JOIN LATERAL'))
        return { rows: pats.map((x) => ({ id: x.p, first_name: 'Ana', country: 'AR', lat: null, lng: null, geocode_quality: null, geocode_partial_match: null, neighborhood: null })) };
      throw new Error(`consulta inesperada: ${q.slice(0, 60)}`);
    });
    const env = await readWorkerWindow({ query } as never, { workerId: W1, today: TODAY });
    expect(env.items.length).toBeGreaterThan(0);
    expect(env.items.every((i) => i.patient_first_name === 'Ana')).toBe(true);
    expect([...new Set(env.items.map((i) => i.patient_ref))].sort()).toEqual([patientRefOf(PAT), patientRefOf(PAT2)].sort());
  });

  it('T-F2a-03 windowStart 31/03 → 2026-02-01', () => {
    expect(windowStart('2026-03-31')).toBe('2026-02-01');
  });

  it('T-F2a-03 windowStart 10/01 → 2025-12-01 (virada de ano)', () => {
    expect(windowStart('2026-01-10')).toBe('2025-12-01');
  });

  it('T-F2a-03 o reader consulta a partir de windowStart(today): params [worker, 2026-10-01, 2026-11-16]', async () => {
    const client = fakeClient({});
    await readWorkerWindow(client as never, { workerId: W1, today: TODAY });
    const calls = client.query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[0][1]).toEqual([W1, windowStart(TODAY), '2026-11-16']);
    expect(windowStart(TODAY)).toBe('2026-10-01');
  });
});
