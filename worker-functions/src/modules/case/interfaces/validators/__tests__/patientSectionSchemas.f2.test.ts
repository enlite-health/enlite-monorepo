/**
 * patientSectionSchemas — spec 016 F2 (D263): `clinicalSpecialty` SAI do payload da seção
 * clínica (a admissão para de aceitar o campo) — a COLUNA `patients.clinical_specialty` não é
 * dropada (229 ocorrências, view `patients_ro`), só o formulário de admissão para de escrevê-la.
 * `.strict()` faz um cliente que ainda manda o campo receber 400 "Invalid body" (mesmo caminho
 * de `deviceType`, já removido no bloco B) — nunca um 500 silencioso.
 */
import { clinicalSectionSchema } from '../patientSectionSchemas';

describe('patientSectionSchemas — clinical (spec 016 F2)', () => {
  it('clinicalSpecialty não é mais aceito — .strict() recusa (400, não grava) mesmo com valor VÁLIDO do enum', () => {
    // 'ASD' é um valor legítimo de CLINICAL_SPECIALTIES — se isto passasse, seria porque o
    // campo ainda está declarado no schema, não porque o valor é inválido.
    const result = clinicalSectionSchema.safeParse({ clinicalSpecialty: 'ASD' });
    expect(result.success).toBe(false);
  });

  it('o resto da seção clínica continua aceito sem clinicalSpecialty', () => {
    const result = clinicalSectionSchema.safeParse({
      diagnosis: 'texto livre',
      dependencyLevel: null,
      clinicalSegments: null,
      deviceTypes: ['HOME'],
    });
    expect(result.success).toBe(true);
  });
});
