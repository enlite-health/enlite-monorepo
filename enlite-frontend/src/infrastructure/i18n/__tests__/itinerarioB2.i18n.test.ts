/**
 * 058b B2 — chaves de i18n do itinerário (es/pt-BR). Arquivo compartilhado pelos cartões de i18n da B2:
 * cada um acrescenta o seu `it`.
 */
import { describe, it, expect } from 'vitest';
import esJson from '../locales/es.json';
import ptBRJson from '../locales/pt-BR.json';

const get = (json: unknown, path: string) => path.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], json);
const ITIN = 'admin.patients.detail.itinerary';

describe('itinerário B2 — i18n', () => {
  it('capacidade: chaves do editModal e actionErrors existem em es e pt-BR (texto literal em es)', () => {
    const paths = [
      `${ITIN}.editModal.addWorker`,
      `${ITIN}.editModal.capacityFull`,
      `${ITIN}.editModal.capacityNotInformed`,
      `${ITIN}.actionErrors.ITINERARY_SLOT_CAPACITY_EXCEEDED`,
    ];
    for (const p of paths) {
      expect(typeof get(esJson, p) === 'string' && (get(esJson, p) as string).length > 0, `es ${p}`).toBe(true);
      expect(typeof get(ptBRJson, p) === 'string' && (get(ptBRJson, p) as string).length > 0, `pt-BR ${p}`).toBe(true);
    }
    expect(get(esJson, `${ITIN}.editModal.capacityFull`)).toContain('{{count}}');
    expect(get(esJson, `${ITIN}.editModal.addWorker`)).toBe('Agregar profesional');
    expect(get(esJson, `${ITIN}.actionErrors.ITINERARY_SLOT_CAPACITY_EXCEEDED`)).toBe('La franja ya tiene todos los prestadores que necesita el servicio. Actualizamos la pantalla.');
  });

  it('Caso A/B: chaves de substitution e actionErrors existem em es e pt-BR (texto literal em es)', () => {
    const SUB = 'admin.patients.detail.serviceTeam.substitution';
    const paths = [
      ...['startLabel', 'startNow', 'startScheduled', 'scheduledDate', 'scheduledReserveOnly'].map((k) => `${SUB}.${k}`),
      ...['ITINERARY_OVERLAP', 'ALLOCATION_NOT_ACTIVE', 'REPLACEMENT_DATE_IN_PAST', 'DESTINATION_NOT_AVAILABLE_FOR_SCHEDULED'].map((k) => `${ITIN}.actionErrors.${k}`),
    ];
    for (const p of paths) {
      expect(typeof get(esJson, p) === 'string' && (get(esJson, p) as string).length > 0, `es ${p}`).toBe(true);
      expect(typeof get(ptBRJson, p) === 'string' && (get(ptBRJson, p) as string).length > 0, `pt-BR ${p}`).toBe(true);
    }
    expect(get(esJson, `${SUB}.scheduledReserveOnly`)).toContain('{{date}}');
    expect(get(esJson, `${SUB}.startNow`)).toBe('Ahora');
    expect(get(esJson, `${SUB}.startScheduled`)).toBe('Programada');
  });
});
