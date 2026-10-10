import { describe, it, expect } from 'vitest';
import { refusalFromError } from '../PatientStatusRefusal';

describe('refusalFromError', () => {
  it('lê code, destino e só os códigos de completude CONHECIDOS', () => {
    expect(refusalFromError({ code: 'PATIENT_STATUS_NOT_READY', details: { to: 'SEARCHING', missing: ['SERVICE_SCHEDULE', 'LIXO'] } }, 'ACTIVE'))
      .toEqual({ code: 'PATIENT_STATUS_NOT_READY', to: 'SEARCHING', missing: ['SERVICE_SCHEDULE'] });
  });
  it('sem details (ou corpo estranho) usa o destino de reserva e não inventa missing; destino desconhecido some', () => {
    expect(refusalFromError({ code: 'X' }, 'ALTA')).toEqual({ code: 'X', to: 'ALTA', missing: undefined });
    expect(refusalFromError({ details: { to: 'NOVO', missing: { a: 1 } } }, 'BAR')).toEqual({ code: undefined, to: undefined, missing: undefined });
    expect(refusalFromError({ details: 'texto' }, undefined).to).toBeUndefined();
  });
});
