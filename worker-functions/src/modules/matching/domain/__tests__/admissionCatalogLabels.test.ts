import { DEPENDENCY_LEVELS } from '@modules/case/domain/enums/DependencyLevel';
import { PROFESSIONS } from '@modules/worker/domain/enums/Profession';
import { ADMISSION_STAFFING_RULES } from '../admissionStaffingRules';
import { DEPENDENCY_LABELS_ES, PROFESSION_LABELS_ES } from '../admissionCatalogLabels';

describe('rótulos ES dos catálogos do Gem', () => {
  it('todo valor de DependencyLevel tem rótulo (e o mapa não tem sobra)', () => {
    for (const l of DEPENDENCY_LEVELS) expect(DEPENDENCY_LABELS_ES[l]).toEqual(expect.any(String));
    expect(Object.keys(DEPENDENCY_LABELS_ES).sort()).toEqual([...DEPENDENCY_LEVELS].sort());
  });
  it('toda Profession tem rótulo (e o mapa não tem sobra)', () => {
    for (const p of PROFESSIONS) expect(PROFESSION_LABELS_ES[p]).toEqual(expect.any(String));
    expect(Object.keys(PROFESSION_LABELS_ES).sort()).toEqual([...PROFESSIONS].sort());
  });
  it('regras do Marcel (10/10/2026): os 4 marcadores, com os números acordados', () => {
    expect(Object.keys(ADMISSION_STAFFING_RULES).sort()).toEqual([
      'MAX_HORAS_POR_TURNO', 'MAX_HORAS_SEMANALES_POR_PRESTADOR', 'REGLA_COBERTURA_SUPLENTE', 'REGLA_TURNOS_NOCTURNOS_Y_FINES_DE_SEMANA',
    ]);
    expect(ADMISSION_STAFFING_RULES.MAX_HORAS_SEMANALES_POR_PRESTADOR).toBe('60 horas semanales por prestador');
    expect(ADMISSION_STAFFING_RULES.MAX_HORAS_POR_TURNO).toBe('12 horas por turno');
    expect(ADMISSION_STAFFING_RULES.REGLA_COBERTURA_SUPLENTE).toContain('Máximo 8 prestadores activos por paciente.');
  });
});
