import {
  patientParamsSchema,
  diagnosisParamsSchema,
  createDiagnosisSchema,
  patchDiagnosisSchema,
} from '../diagnosisSchemas';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

describe('diagnosisSchemas (spec 016 F2)', () => {
  it('patientParamsSchema exige UUID', () => {
    expect(patientParamsSchema.safeParse({ id: ID }).success).toBe(true);
    expect(patientParamsSchema.safeParse({ id: 'nao-uuid' }).success).toBe(false);
  });

  it('diagnosisParamsSchema exige os dois UUIDs', () => {
    expect(diagnosisParamsSchema.safeParse({ id: ID, did: ID2 }).success).toBe(true);
    expect(diagnosisParamsSchema.safeParse({ id: ID, did: 'x' }).success).toBe(false);
  });

  it('createDiagnosisSchema: só conceptUri (+ isPrimary opcional); NUNCA aceita code/title/chapter/release do cliente', () => {
    expect(createDiagnosisSchema.safeParse({ conceptUri: 'http://x' }).success).toBe(true);
    expect(createDiagnosisSchema.safeParse({ conceptUri: 'http://x', isPrimary: true }).success).toBe(true);
    expect(createDiagnosisSchema.safeParse({ conceptUri: '' }).success).toBe(false);
    expect(createDiagnosisSchema.safeParse({}).success).toBe(false);
    expect(createDiagnosisSchema.safeParse({ conceptUri: 'http://x', code: '6A02.Z' }).success).toBe(false);
  });

  it('patchDiagnosisSchema: isPrimary só true, active só false, exatamente um dos dois', () => {
    expect(patchDiagnosisSchema.safeParse({ isPrimary: true }).success).toBe(true);
    expect(patchDiagnosisSchema.safeParse({ active: false }).success).toBe(true);
    expect(patchDiagnosisSchema.safeParse({ isPrimary: false }).success).toBe(false);
    expect(patchDiagnosisSchema.safeParse({ active: true }).success).toBe(false);
    expect(patchDiagnosisSchema.safeParse({}).success).toBe(false);
    expect(patchDiagnosisSchema.safeParse({ isPrimary: true, active: false }).success).toBe(false);
  });
});
