/**
 * Adaptadores de banco do "Cómo llegar" (spec 077 FR-46): o SQL da zona (critério do /admin/mapa), o uid só no SELECT do
 * prestador e o itinerário filtrado por `patient_ref` a partir do Reader do case. Cliente `pg` falso; dados sintéticos.
 */
import type { ItineraryEnvelope, ItineraryItem } from '@modules/case/infrastructure/WorkerItineraryReader';
import { CaseItineraryAdapter, PgWorkerZoneReader, TRANSIT_ZONE_SQL, type RunInActorContext } from '../WorkerTransitReaders';

const WID = '11111111-1111-4111-8111-111111111111';
const REF = '9f103f86-26dc-53ac-8c3a-92951d0e0537';

function runWith(rows: { worker: unknown[]; zone: unknown[] }) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM workers')) return { rows: rows.worker };
    if (sql.includes('FROM worker_service_areas')) return { rows: rows.zone };
    throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
  });
  const run: RunInActorContext = (fn) => fn({ query } as never);
  return { run, query };
}

const it0 = (over: Partial<ItineraryItem>): ItineraryItem => ({
  occurrence_id: '43876dea-477d-5c5b-8b30-127aa6db3f92', slot_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', assignment_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  on_date: '2026-11-03', starts_at: '2026-11-03T11:00:00Z', ends_at: '2026-11-03T19:00:00Z', kind: 'REGULAR', patient_first_name: 'Paciente',
  patient_ref: REF, neighborhood: null, address: null, patient_point: null, country: 'AR', seq: 1, ...over,
});

describe('WorkerTransitReaders', () => {
  it('T-F4-04 PgWorkerZoneReader: zona viva mais recente com ponto; o uid vai só no SELECT do prestador; sem zona → zone null', async () => {
    expect(TRANSIT_ZONE_SQL).toContain('deleted_at IS NULL');
    expect(TRANSIT_ZONE_SQL).toContain('NOT (latitude = 0 AND longitude = 0)');
    expect(TRANSIT_ZONE_SQL).toContain('ORDER BY updated_at DESC LIMIT 1');
    // D722: a origem é só o bairro; o endereço (rua e número) da prestadora não sai do banco para esta rota.
    expect(TRANSIT_ZONE_SQL).toContain('neighborhood');
    expect(TRANSIT_ZONE_SQL).not.toContain('address_line');
    const com = runWith({ worker: [{ id: WID, status: 'REGISTERED' }], zone: [{ neighborhood: 'Zona', latitude: '-38.0023', longitude: '-57.5575' }] });
    expect(await new PgWorkerZoneReader(com.run).findByAuthUid('uid-token')).toEqual({ found: true, workerId: WID, disabled: false, zone: { label: 'Zona', point: { lat: -38.0023, lng: -57.5575 } } });
    expect(com.query.mock.calls.map((c) => c[1])).toEqual([['uid-token'], [WID]]);
    // sem bairro cadastrado o rótulo fica vazio: nunca cai para o endereço (D722)
    const semBairro = runWith({ worker: [{ id: WID, status: 'REGISTERED' }], zone: [{ neighborhood: null, address_line: 'Calle Falsa 123', latitude: '-38.0023', longitude: '-57.5575' }] });
    expect(await new PgWorkerZoneReader(semBairro.run).findByAuthUid('uid-token')).toMatchObject({ zone: { label: '' } });
    const sem = runWith({ worker: [{ id: WID, status: 'DISABLED' }], zone: [] });
    expect(await new PgWorkerZoneReader(sem.run).findByAuthUid('uid-token')).toEqual({ found: true, workerId: WID, disabled: true, zone: null });
    expect(await new PgWorkerZoneReader(runWith({ worker: [], zone: [] }).run).findByAuthUid('x')).toEqual({ found: false });
  });

  it('T-F4-04 CaseItineraryAdapter: só os itens do patient_ref, com hasAddress, país e ponto do Reader', async () => {
    const env: ItineraryEnvelope = { worker_id: WID, items: [
      it0({ address: { street: 'Calle Falsa', number: '123', floor_unit: null, neighborhood: null, city: null }, patient_point: { lat: -38.0001, lng: -57.5, quality: 'UNRELIABLE' }, country: 'AR' }),
      it0({ on_date: '2026-11-11', address: null, country: 'AR' }),
      it0({ patient_ref: '00000000-0000-5000-8000-000000000000', country: 'BR' }),
    ], tombstones: [], cursor: 'c', full: true };
    const read = jest.fn(async () => env);
    const { run } = runWith({ worker: [], zone: [] });
    const items = await new CaseItineraryAdapter(run, read as never).itemsOf(WID, REF, '2026-11-02');
    expect(read).toHaveBeenCalledWith(expect.anything(), { workerId: WID, today: '2026-11-02' });
    expect(items).toEqual([
      { hasAddress: true, country: 'AR', point: { lat: -38.0001, lng: -57.5 } },
      { hasAddress: false, country: 'AR', point: null },
    ]);
  });
});
