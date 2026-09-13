/**
 * patientSectionSchemas — spec 018 PR-3 (Emenda 13/09 do registro de operações; `lex`
 * CONDICIONADO #2a/#2b, migration 425): `general` ganha `gender` (enum fechado,
 * FEMALE/MALE/NON_BINARY/OTHER/PREFER_NOT_TO_SAY) e `languages` (lista fechada ISO pt/es/en).
 * Os dois são SEMPRE facultativos (Ley 25.326 art. 7 inc. 1) — nunca `.min`/obrigatório.
 */
import { generalSectionSchema } from '../patientSectionSchemas';
import { PATIENT_GENDERS } from '../../../domain/enums/PatientGender';
import { PATIENT_LANGUAGES } from '../../../domain/enums/PatientLanguage';

describe('patientSectionSchemas — general += gender/languages (spec 018 PR-3)', () => {
  it('aceita cada valor do enum fechado de gender, e null ("não perguntado")', () => {
    for (const g of PATIENT_GENDERS) {
      expect(generalSectionSchema.safeParse({ gender: g }).success).toBe(true);
    }
    expect(generalSectionSchema.safeParse({ gender: null }).success).toBe(true);
    expect(generalSectionSchema.safeParse({}).success).toBe(true); // ausente = facultativo, não obrigatório
  });

  it('recusa valor de gender fora do enum fechado (categoria proibida ou digitação livre) — 400', () => {
    for (const bad of ['SEXUAL_ORIENTATION_X', 'CATOLICO', 'BLANCA', 'xpto', '']) {
      const r = generalSectionSchema.safeParse({ gender: bad });
      expect(r.success).toBe(false);
    }
  });

  it('aceita languages como subconjunto de pt/es/en, vazio, e null', () => {
    expect(generalSectionSchema.safeParse({ languages: ['pt', 'es'] }).success).toBe(true);
    expect(generalSectionSchema.safeParse({ languages: [...PATIENT_LANGUAGES] }).success).toBe(true);
    expect(generalSectionSchema.safeParse({ languages: [] }).success).toBe(true);
    expect(generalSectionSchema.safeParse({ languages: null }).success).toBe(true);
  });

  it('recusa idioma fora da lista fechada e forma errada (não-array)', () => {
    expect(generalSectionSchema.safeParse({ languages: ['fr'] }).success).toBe(false);
    expect(generalSectionSchema.safeParse({ languages: 'pt' }).success).toBe(false);
    expect(generalSectionSchema.safeParse({ languages: ['pt', 'pt', 'pt', 'pt'] }).success).toBe(false); // > PATIENT_LANGUAGES.length
  });

  it('.strict() continua recusando chave estranha mesmo com gender/languages válidos (whitelist não relaxou)', () => {
    const r = generalSectionSchema.safeParse({ gender: 'FEMALE', languages: ['es'], sexualOrientation: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].code).toBe('unrecognized_keys');
  });
});
