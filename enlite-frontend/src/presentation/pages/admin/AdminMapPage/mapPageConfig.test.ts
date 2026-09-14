import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { WORKER_PROFESSIONS } from '@domain/entities/Worker';
import { PATIENT_STATUSES as PATIENT_STATUSES_V2 } from '@domain/entities/patientEnums';
import {
  DEFAULT_CENTER, DEFAULT_CENTER_BY_COUNTRY, DEFAULT_COUNTRY, DEFAULT_RADIUS_KM, PATIENT_STATUS_COLOR, PATIENT_STATUSES, PROFESSIONS, WORKER_STATUS_COLOR,
  distanceLabel, legendEntries, patientDetails, patientPointTitle, patientStatusLabel, placeLabel, professionLabel,
  sameCenter, workerDetails, workerPointTitle, workerStatusLabel,
} from './mapPageConfig';

// t que devolve o fallback (a chave nunca é traduzida aqui — o que se testa é a composição)
const t = ((key: string, fallback?: string | Record<string, unknown>) => {
  if (typeof fallback === 'string') return fallback;
  if (fallback && typeof fallback === 'object') return String(fallback.defaultValue).replace('{{count}}', String(fallback.count));
  return key;
}) as unknown as TFunction;

describe('mapPageConfig', () => {
  it('centro padrão por país: AR nasce em CABA, BR em São Paulo; o raio nasce em 5 km (Marcel na tela, 02/09)', () => {
    expect(DEFAULT_COUNTRY).toBe('AR');
    expect(DEFAULT_CENTER_BY_COUNTRY.AR).toEqual({ lat: -34.6037, lng: -58.3816 });
    expect(DEFAULT_CENTER_BY_COUNTRY.BR).toEqual({ lat: -23.5505, lng: -46.6333 });
    expect(DEFAULT_CENTER).toBe(DEFAULT_CENTER_BY_COUNTRY.AR);
    expect(DEFAULT_RADIUS_KM).toBe(5);
    // profissões vêm da entidade de domínio, não de lista própria
    expect(PROFESSIONS).toBe(WORKER_PROFESSIONS);
    expect(WORKER_STATUS_COLOR.REGISTERED).not.toBe(WORKER_STATUS_COLOR.INCOMPLETE_REGISTER);
    expect(PATIENT_STATUS_COLOR.ACTIVE).toBeDefined();
  });

  it('QA 🟡4: status v2 — a lista É a fonte viva (patientEnums.ts), cor para ON_HOLD/SEARCHING/REPLACEMENT, DISCONTINUED fora', () => {
    expect(PATIENT_STATUSES).toBe(PATIENT_STATUSES_V2);
    for (const status of PATIENT_STATUSES_V2) {
      expect(PATIENT_STATUS_COLOR[status], `sem cor: ${status}`).toBeDefined();
    }
    expect(PATIENT_STATUS_COLOR.ON_HOLD).toBeDefined();
    expect(PATIENT_STATUS_COLOR.SEARCHING).toBeDefined();
    expect(PATIENT_STATUS_COLOR.REPLACEMENT).toBeDefined();
    expect(PATIENT_STATUS_COLOR.DISCONTINUED).toBeUndefined();
    expect(PATIENT_STATUSES).not.toContain('DISCONTINUED');
  });

  it('rótulos com fallback para valor desconhecido', () => {
    expect(workerStatusLabel(t, 'REGISTERED')).toBe('Documentación completa');
    expect(workerStatusLabel(t, 'XYZ')).toBe('XYZ');
    expect(patientStatusLabel(t, 'PENDING_ADMISSION')).toBe('Esperando financiero');
    expect(patientStatusLabel(t, 'ON_HOLD')).toBe('En espera');
    expect(patientStatusLabel(t, 'SEARCHING')).toBe('Búsqueda');
    expect(patientStatusLabel(t, 'REPLACEMENT')).toBe('Reemplazo');
    expect(patientStatusLabel(t, 'XYZ')).toBe('XYZ');
    // status NULL no banco (visto no e2e): nunca a chave crua
    expect(patientStatusLabel(t, null)).toBe('Sin estado');
    expect(workerStatusLabel(t, null)).toBe('Sin estado');
    expect(professionLabel(t, 'AT')).toBe('AT');
    expect(professionLabel(t, 'OTHER')).toBe('OTHER');
    expect(professionLabel(t, null)).toBe('Sin profesión');
  });

  it('placeLabel e distanceLabel', () => {
    expect(placeLabel({ city: 'CABA', neighborhood: 'Flores' })).toBe('Flores · CABA');
    expect(placeLabel({ city: null, neighborhood: null })).toBe('');
    expect(distanceLabel(null)).toBe('');
    expect(distanceLabel(2.345)).toBe('2.3 km');
    expect(distanceLabel(12.6)).toBe('13 km');
  });

  it('linha de detalhe: a MESMA para a lista e para o balão, com "sin ubicación" quando não há lugar nem coordenada', () => {
    const w = { id: 'w', name: 'Ana', lat: 0, lng: 0, status: 'INCOMPLETE_REGISTER', documentsComplete: false, profession: 'CAREGIVER', city: 'CABA', neighborhood: null, state: null, distanceKm: null };
    expect(workerDetails(t, w)).toBe('Cuidador · Registro incompleto · CABA');
    expect(workerDetails(t, { ...w, lat: null, lng: null, city: null })).toBe('Cuidador · Registro incompleto · sin ubicación');
    // tem coordenada mas o endereço não traz cidade/bairro: omite o lugar, não mente "sin ubicación"
    expect(workerDetails(t, { ...w, city: null })).toBe('Cuidador · Registro incompleto');

    const p = { id: 'p', addressId: 'a', name: 'Luz', lat: 0, lng: 0, status: 'ACTIVE', city: null, neighborhood: null, state: null, openVacancies: 2, distanceKm: null };
    expect(patientDetails(t, p)).toBe('Activo · 2 vacante(s) abierta(s)');
    expect(patientDetails(t, { ...p, openVacancies: 0 })).toBe('Activo');
    expect(patientDetails(t, { ...p, lat: null, lng: null, openVacancies: 0 })).toBe('Activo · sin ubicación');
  });

  it('tooltip nativo do pino: nome + a linha de detalhe, sem dado clínico', () => {
    expect(workerPointTitle(t, { id: 'w', name: 'Ana', lat: 0, lng: 0, status: 'INCOMPLETE_REGISTER', documentsComplete: false, profession: 'CAREGIVER', city: 'CABA', neighborhood: null, state: null, distanceKm: null }))
      .toBe('Ana — Cuidador · Registro incompleto · CABA');
    expect(patientPointTitle(t, { id: 'p', addressId: 'a', name: 'Luz', lat: 0, lng: 0, status: 'ACTIVE', city: null, neighborhood: null, state: null, openVacancies: 2, distanceKm: null }))
      .toBe('Luz — Activo · 2 vacante(s) abierta(s)');
  });

  it('legenda: uma entrada por COR, com os status que dividem a cor juntos', () => {
    const w = legendEntries(t, 'workers');
    expect(w.map((e) => e.label)).toEqual(['Documentación completa', 'Registro incompleto', 'Dado de baja']);
    const p = legendEntries(t, 'patients');
    // QA 🟡4: status v2 — 9 status, 8 cores (ADMISSION/PENDING_ADMISSION dividem 1; os demais,
    // inclusive ON_HOLD/SEARCHING/REPLACEMENT novos, têm cor própria).
    expect(p).toHaveLength(8);
    expect(p.map((e) => e.color)).toEqual([...new Set(p.map((e) => e.color))]);
    expect(p.find((e) => e.label.includes('/'))?.label).toBe('En admisión / Esperando financiero');
  });

  it('sameCenter compara por valor', () => {
    expect(sameCenter({ lat: 1, lng: 2 }, { lat: 1, lng: 2 })).toBe(true);
    expect(sameCenter({ lat: 1, lng: 2 }, { lat: 1, lng: 3 })).toBe(false);
  });
});
