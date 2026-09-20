/**
 * Barrel do módulo — garante que todo import externo declarado aqui resolve de verdade
 * (regressão de "esqueci de exportar" e cobertura do próprio arquivo, que é só re-export).
 */
import * as anacareHours from '../index';

describe('anacare-hours barrel', () => {
  it('exporta as classes e funções do contrato público', () => {
    expect(anacareHours.AnaCareHoursController).toBeDefined();
    expect(anacareHours.createAnaCareHoursRoutes).toBeDefined();
    expect(anacareHours.AnaCareHoursService).toBeDefined();
    expect(anacareHours.ShiftHoursValidationRepository).toBeDefined();
    expect(anacareHours.WorkerLinkRepository).toBeDefined();
    expect(anacareHours.FakeAnaCareShiftsSource).toBeDefined();
    expect(anacareHours.createAnaCareShiftsSource).toBeDefined();
    expect(anacareHours.ANACARE_HOURS_SOURCE_ENV).toBe('ANACARE_HOURS_SOURCE');
    expect(anacareHours.CONTEST_REASONS).toEqual(['no_asistio', 'horario_distinto', 'horas_mal_cargadas', 'otro']);
    expect(anacareHours.isContestReason('otro')).toBe(true);
    expect(anacareHours.CONTEST_NOTE_MAX_LENGTH).toBe(500);
    expect(anacareHours.AnaCareHoursServiceError).toBeDefined();
    expect(anacareHours.AnaCareDirectorySnapshotRepository).toBeDefined();
    expect(anacareHours.FakeEnliteDirectory).toBeDefined();
    expect(anacareHours.FakeAnaCareDirectorySnapshotRepository).toBeDefined();
    expect(anacareHours.createAnaCareSyncDependencies).toBeDefined();
    expect(anacareHours.AnaCareHoursSyncRunner).toBeDefined();
    expect(anacareHours.AnaCareDirectoryDroppedError).toBeDefined();
  });
});
