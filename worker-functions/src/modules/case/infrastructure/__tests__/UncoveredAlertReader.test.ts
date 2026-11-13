/**
 * UncoveredAlertReader — spec 077 F1 (bloco 1.4): paciente de teste (`patients.is_test`) não entra no universo do alerta
 * "Sin cubrir" nem nos rótulos do e-mail. Cliente `pg` falso: registra o SQL e devolve as linhas, aplicando o filtro
 * `is_test = false` SÓ quando o SQL enviado o contém (sem o filtro no SQL, o paciente de teste volta).
 */
import { UncoveredAlertReader } from '../UncoveredAlertReader';

type Row = { patient_id: string; is_test: boolean; [k: string]: unknown };

const NORMAL = 'p-normal';
const TESTE = 'p-teste';

const slots: Row[] = [NORMAL, TESTE].map((id) => ({
  patient_id: id,
  is_test: id === TESTE,
  slot_id: `s-${id}`,
  service_id: `svc-${id}`,
  weekday: 1,
  start_time: '08:00',
  slot_end: '12:00',
  valid_range: '[2026-10-01,)',
}));
const labels: Row[] = [NORMAL, TESTE].map((id) => ({
  patient_id: id,
  is_test: id === TESTE,
  service_id: `svc-${id}`,
  service_code: 'AT',
  patient_name: `Nome ${id}`,
}));

function fakeClient() {
  const query = jest.fn(async (sql: string) => {
    const s = String(sql);
    const keep = (rows: Row[]) => (/p\.is_test = false/.test(s) ? rows.filter((r) => !r.is_test) : rows);
    if (/FROM patient_itinerary_slot s\s+JOIN patient_contracted_services/.test(s) && !/patient_itinerary_assignment a/.test(s)) return { rows: keep(slots) };
    if (/FROM patient_itinerary_assignment a/.test(s) || /FROM patient_itinerary_absence ab/.test(s)) return { rows: [] };
    if (/FROM patients p\s+JOIN patient_contracted_services pcs/.test(s)) return { rows: keep(labels) };
    // readAlertUniverseFacts: devolve fatos para todos os ids pedidos
    return { rows: [NORMAL, TESTE].map((id) => ({ id, status: 'ACTIVE', assembled: true })) };
  });
  return { query };
}

describe('UncoveredAlertReader — paciente de teste fica de fora (spec 077 F1)', () => {
  it('readUniverse: o SQL das 3 leituras de ocorrência filtra p.is_test = false e só o paciente normal volta', async () => {
    const client = fakeClient();
    const out = await new UncoveredAlertReader().readUniverse(client as never, 'AR', '2026-10-29');

    const occurrenceSqls = client.query.mock.calls.map(([sql]) => String(sql)).filter((sql) => /patient_itinerary_(slot|assignment|absence)/.test(sql));
    expect(occurrenceSqls).toHaveLength(3);
    for (const sql of occurrenceSqls) expect(sql).toMatch(/p\.is_test = false/);
    expect(out.map((u) => u.patientId)).toEqual([NORMAL]);
  });

  it('readLabels: o WHERE filtra p.is_test = false e só o paciente normal volta', async () => {
    const client = fakeClient();
    const out = await new UncoveredAlertReader().readLabels(client as never, [NORMAL, TESTE]);

    const [sql] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/p\.deleted_at IS NULL AND p\.is_test = false/);
    expect(out.map((l) => l.patientId)).toEqual([NORMAL]);
  });
});
