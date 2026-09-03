/**
 * patientClinicalAccess.test.ts — o ponto único de leitura do texto clínico restrito (D211.2):
 * null = engine não decidiu (lê, D113) · [] = sem célula (redige) · com a célula (lê).
 */
import { Request } from 'express';
import { canReadPatientClinical, clinicalCellsOf, projectPatientClinicalForActor, PATIENT_CLINICAL_READ_CELL, CLINICAL_RESTRICTED_FIELDS } from '../patientClinicalAccess';

const patient = { id: 'p1', diagnosis: 'x', emergencyInstructions: 'Llamar 107', emergencyInstructionsUpdatedAt: 'd', emergencyInstructionsUpdatedBy: 'Gabi', additionalComments: 'ok' };

describe('patientClinicalAccess', () => {
  it('canReadPatientClinical: null/undefined → true (o que a rota devolvia antes); [] → false; com a célula → true', () => {
    expect(canReadPatientClinical(null)).toBe(true);
    expect(canReadPatientClinical(undefined)).toBe(true);
    expect(canReadPatientClinical([])).toBe(false);
    expect(canReadPatientClinical(['patient:read'])).toBe(false);
    expect(canReadPatientClinical(['patient:read', PATIENT_CLINICAL_READ_CELL])).toBe(true);
  });

  it('clinicalCellsOf lê req.permissionCells (ausente → null)', () => {
    expect(clinicalCellsOf({} as Request)).toBeNull();
    expect(clinicalCellsOf({ permissionCells: [] } as unknown as Request)).toEqual([]);
    expect(clinicalCellsOf({ permissionCells: ['a'] } as unknown as Request)).toEqual(['a']);
  });

  it('projeção: quem pode lê o MESMO objeto; quem não pode recebe os campos restritos null + flag, e nada mais muda', () => {
    expect(projectPatientClinicalForActor(patient, null)).toBe(patient);
    const red = projectPatientClinicalForActor(patient, []);
    expect(red).not.toBe(patient);
    expect(red.emergencyInstructionsRedacted).toBe(true);
    for (const f of CLINICAL_RESTRICTED_FIELDS) expect((red as Record<string, unknown>)[f]).toBeNull();
    expect(red.diagnosis).toBe('x'); expect(red.additionalComments).toBe('ok');
    expect(patient.emergencyInstructions).toBe('Llamar 107'); // original intacto
    expect(CLINICAL_RESTRICTED_FIELDS).toEqual(['emergencyInstructions', 'emergencyInstructionsUpdatedAt', 'emergencyInstructionsUpdatedBy', 'onHoldNote']);
  });

  it('C7: a flag de redação sai mesmo com o campo NULL — não revela se existe conteúdo', () => {
    const red = projectPatientClinicalForActor({ id: 'p', emergencyInstructions: null, emergencyInstructionsUpdatedAt: null, emergencyInstructionsUpdatedBy: null }, []);
    expect(red.emergencyInstructionsRedacted).toBe(true);
  });
});

describe('contrato com o engine do ABAC (D113): `req.permissionCells`', () => {
  it('a propriedade lida chama-se EXATAMENTE `permissionCells` — outro nome é ignorado (null = comportamento anterior)', () => {
    expect(clinicalCellsOf({ cells: [] } as unknown as Request)).toBeNull();
    expect(clinicalCellsOf({ permission_cells: [] } as unknown as Request)).toBeNull();
    expect(clinicalCellsOf({ permissionCells: null } as unknown as Request)).toBeNull();
    expect(clinicalCellsOf({ permissionCells: [] } as unknown as Request)).toEqual([]);
  });

  it('ponta a ponta do helper: request sem engine NÃO redige; request com `permissionCells: []` REDIGE', () => {
    const semEngine = projectPatientClinicalForActor(patient, clinicalCellsOf({} as Request));
    expect(semEngine).toBe(patient);
    expect(semEngine.emergencyInstructionsRedacted).toBeUndefined();

    const comEngineSemCelula = projectPatientClinicalForActor(patient, clinicalCellsOf({ permissionCells: [] } as unknown as Request));
    expect(comEngineSemCelula.emergencyInstructions).toBeNull();
    expect(comEngineSemCelula.emergencyInstructionsRedacted).toBe(true);

    const comCelula = projectPatientClinicalForActor(patient, clinicalCellsOf({ permissionCells: [PATIENT_CLINICAL_READ_CELL] } as unknown as Request));
    expect(comCelula).toBe(patient);
  });
});
