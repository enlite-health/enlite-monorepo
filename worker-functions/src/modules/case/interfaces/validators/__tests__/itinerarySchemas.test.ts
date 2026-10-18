import { patientItinerarySlotSchema } from '../itinerarySchemas';

const SLOT = {
  id: '11111111-1111-4111-8111-111111111111',
  weekday: 6,
  startTime: '20:00',
  endTime: '08:00',
  durationMinutes: 720,
  assignments: [],
};

describe('patientItinerarySlotSchema', () => {
  it('aceita a faixa com início + duração (fim derivado)', () => {
    expect(patientItinerarySlotSchema.safeParse(SLOT).success).toBe(true);
  });

  it('slot sem durationMinutes é recusado', () => {
    const { durationMinutes: _omit, ...semDuracao } = SLOT;
    expect(patientItinerarySlotSchema.safeParse(semDuracao).success).toBe(false);
  });

  it('durationMinutes fora de 1..1440 ou não inteiro é recusado', () => {
    for (const d of [0, 1441, 90.5]) {
      expect(patientItinerarySlotSchema.safeParse({ ...SLOT, durationMinutes: d }).success).toBe(false);
    }
    expect(patientItinerarySlotSchema.safeParse({ ...SLOT, durationMinutes: 1440 }).success).toBe(true);
  });

  it('slot com active é recusado (.strict)', () => {
    expect(patientItinerarySlotSchema.safeParse({ ...SLOT, active: true }).success).toBe(false);
  });
});
