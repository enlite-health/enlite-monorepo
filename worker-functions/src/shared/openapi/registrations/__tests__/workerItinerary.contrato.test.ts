/**
 * workerItinerary.contrato.test.ts — o item que o Reader DEVOLVE passa no schema que a doc PUBLICA, chave por chave
 * (spec 077 FR-39, C-14). O item é tipado com a interface do Reader: chave nova no Reader sem chave aqui quebra o tsc
 * do ts-jest; `.strict()` reprova chave que o Reader emite e a doc não declara.
 */
import { ItineraryItem as ItineraryItemSchema, ItineraryTombstone as ItineraryTombstoneSchema, PatientAddress as PatientAddressSchema } from '../workerItinerary';
import { buildOpenApiDocument } from '../../document';
import { TOMBSTONE_REASONS, type ItineraryItem, type ItineraryTombstone } from '@modules/case/infrastructure/WorkerItineraryReader';

const ITEM: ItineraryItem = {
  occurrence_id: '43876dea-477d-5c5b-8b30-127aa6db3f92',
  slot_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  assignment_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  on_date: '2026-11-02',
  starts_at: '2026-11-02T11:00:00Z',
  ends_at: '2026-11-02T19:00:00Z',
  kind: 'REGULAR',
  patient_first_name: 'Paciente',
  patient_ref: '9f103f86-26dc-53ac-8c3a-92951d0e0537',
  neighborhood: null,
  address: null,
  patient_point: null,
  country: 'AR',
  seq: 1,
};

describe('contrato: item de GET /api/workers/me/itinerary', () => {
  it('T-F2a-04 o item tipado do Reader passa no schema publicado em modo strict (com e sem bairro)', () => {
    expect(ItineraryItemSchema.strict().safeParse(ITEM).success).toBe(true);
    expect(ItineraryItemSchema.strict().safeParse({ ...ITEM, neighborhood: 'Palermo' }).success).toBe(true);
  });

  it('T-F2a-04 a doc declara exatamente as 14 chaves do item, e address só aceita null até a F4', () => {
    expect(Object.keys(ItineraryItemSchema.shape).sort()).toEqual(
      ['address', 'assignment_id', 'country', 'ends_at', 'kind', 'neighborhood', 'occurrence_id', 'on_date', 'patient_first_name', 'patient_point', 'patient_ref', 'seq', 'slot_id', 'starts_at'].sort(),
    );
    expect(ItineraryItemSchema.safeParse({ ...ITEM, address: { street: 'x' } }).success).toBe(false);
  });

  it('T-F2a-04 o documento gerado publica patient_ref, neighborhood e address no 200 da rota', () => {
    const op = JSON.stringify(buildOpenApiDocument().paths['/api/workers/me/itinerary']);
    expect(op).toContain('"patient_ref"');
    expect(op).toContain('"neighborhood"');
    expect(op).toContain('"address"');
  });

  const TOMBSTONE: ItineraryTombstone = { occurrence_id: '43876dea-477d-5c5b-8b30-127aa6db3f92', reason: 'ALLOCATION_ENDED', seq: 1 };

  it('T-F2a-08 o tombstone tipado do Reader passa no schema publicado em modo strict, com cada motivo; motivo fora do conjunto falha', () => {
    for (const reason of TOMBSTONE_REASONS) {
      expect(ItineraryTombstoneSchema.strict().safeParse({ ...TOMBSTONE, reason }).success).toBe(true);
    }
    expect(ItineraryTombstoneSchema.safeParse({ ...TOMBSTONE, reason: 'CANCELLED' }).success).toBe(false);
    expect(ItineraryTombstoneSchema.safeParse({ occurrence_id: TOMBSTONE.occurrence_id, reason: 'ABSENCE' }).success).toBe(false);
  });

  it('T-F2a-08 a doc declara as 3 chaves do tombstone e o enum é exatamente o do Reader (um dono do conjunto)', () => {
    expect(Object.keys(ItineraryTombstoneSchema.shape).sort()).toEqual(['occurrence_id', 'reason', 'seq']);
    expect([...ItineraryTombstoneSchema.shape.reason.options].sort()).toEqual([...TOMBSTONE_REASONS].sort());
  });

  it('T-F2a-08 o documento gerado publica os 3 motivos no 200 da rota e não diz mais "Sempre [] no MVP"', () => {
    const op = JSON.stringify(buildOpenApiDocument().paths['/api/workers/me/itinerary']);
    for (const reason of TOMBSTONE_REASONS) expect(op).toContain(`"${reason}"`);
    expect(op).not.toContain('Sempre [] no MVP');
  });

  const ADDRESS = { street: 'Calle Falsa', number: '123', floor_unit: null, neighborhood: 'Almagro', city: 'CABA' };

  it('T-F4-01 o item com endereço passa no schema strict; a doc declara as 5 chaves de address, todas obrigatórias', () => {
    expect(ItineraryItemSchema.strict().safeParse({ ...ITEM, address: ADDRESS }).success).toBe(true);
    expect(Object.keys(PatientAddressSchema.shape).sort()).toEqual(['city', 'floor_unit', 'neighborhood', 'number', 'street']);
    const { city: _city, ...semCidade } = ADDRESS;
    expect(ItineraryItemSchema.safeParse({ ...ITEM, address: semCidade }).success).toBe(false);
  });

  it('T-F4-01 address com chave a mais (ex.: notas de acesso) é recusado', () => {
    expect(ItineraryItemSchema.safeParse({ ...ITEM, address: { ...ADDRESS, notas: 'x' } }).success).toBe(false);
  });
});
