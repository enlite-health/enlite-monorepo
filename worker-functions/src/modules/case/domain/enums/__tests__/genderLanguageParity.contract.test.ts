import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATIENT_GENDERS } from '../PatientGender';
import { PATIENT_LANGUAGES } from '../PatientLanguage';

/**
 * TESTE DE CONTRATO — spec 018 PR-3 (Emenda 13/09, `lex` L2c-2): a lista fechada de idiomas do
 * paciente é "a MESMA de `workers.languages`" (WORKER_LANGUAGES, pt/es/en) — e o enum de gênero
 * do paciente precisa bater entre back (`PatientGender.ts`/`patientSectionSchemas.ts`) e front
 * (`patientEnums.ts:PATIENT_GENDERS`, consumido por `PatientGeneralEditDrawer.tsx`).
 *
 * Sem CHECK no banco para nenhum dos dois (as colunas são cifradas — nenhuma constraint SQL as
 * alcança, comentário da migration 425): a paridade aqui é SÓ back × front. Molde:
 * `relationshipParity.contract.test.ts` (mesma classe de defeito: lista fechada copiada em mais
 * de um lugar diverge em silêncio).
 *
 * Se este teste falhar, NÃO edite a lista esperada: ajuste o lado que ficou para trás.
 */

const FRONTEND_PATIENT_ENUMS = join(
  __dirname,
  '../../../../../../../enlite-frontend/src/domain/entities/patientEnums.ts',
);
const FRONTEND_WORKER_ENTITY = join(
  __dirname,
  '../../../../../../../enlite-frontend/src/domain/entities/Worker.ts',
);

function extractArray(src: string, constName: string): string[] {
  const match = src.match(new RegExp(`${constName}\\s*=\\s*\\[([^\\]]*)\\]`, 's'));
  if (!match) throw new Error(`Não achei ${constName} — o instrumento está cego.`);
  return [...match[1].matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]).sort();
}

describe('genderLanguageParity.contract — PatientGender/PatientLanguage (back) × patientEnums.ts (front), spec 018 PR-3', () => {
  it('L2c-2: PATIENT_LANGUAGES (back) === PATIENT_LANGUAGES (front) === WORKER_LANGUAGES (front) — pt/es/en, a MESMA lista', () => {
    const doBack = [...PATIENT_LANGUAGES].sort();
    const frontSrc = readFileSync(FRONTEND_PATIENT_ENUMS, 'utf8');
    const doFrontPatient = extractArray(frontSrc, 'PATIENT_LANGUAGES');
    const workerSrc = readFileSync(FRONTEND_WORKER_ENTITY, 'utf8');
    const doFrontWorker = extractArray(workerSrc, 'WORKER_LANGUAGES');

    expect(doBack).toEqual(['en', 'es', 'pt']);
    expect(doFrontPatient).toEqual(doBack);
    expect(doFrontWorker).toEqual(doBack);
  });

  it('L2b-2: PATIENT_GENDERS (back) === PATIENT_GENDERS (front) — FEMALE/MALE/NON_BINARY/OTHER/PREFER_NOT_TO_SAY', () => {
    const doBack = [...PATIENT_GENDERS].sort();
    const frontSrc = readFileSync(FRONTEND_PATIENT_ENUMS, 'utf8');
    const doFront = extractArray(frontSrc, 'PATIENT_GENDERS');

    expect(doBack).toEqual(['FEMALE', 'MALE', 'NON_BINARY', 'OTHER', 'PREFER_NOT_TO_SAY']);
    expect(doFront).toEqual(doBack);
  });

  it('sabotagem: tirar "en" da lista do back faria a comparação com o front acusar (prova de que o instrumento morde)', () => {
    const semIngles = PATIENT_LANGUAGES.filter((l) => l !== 'en');
    const frontSrc = readFileSync(FRONTEND_PATIENT_ENUMS, 'utf8');
    const doFront = extractArray(frontSrc, 'PATIENT_LANGUAGES');
    expect([...semIngles].sort()).not.toEqual(doFront);
  });

  it('sabotagem: tirar PREFER_NOT_TO_SAY da lista do back faria a comparação com o front acusar', () => {
    const semPreferNaoDizer = PATIENT_GENDERS.filter((g) => g !== 'PREFER_NOT_TO_SAY');
    const frontSrc = readFileSync(FRONTEND_PATIENT_ENUMS, 'utf8');
    const doFront = extractArray(frontSrc, 'PATIENT_GENDERS');
    expect([...semPreferNaoDizer].sort()).not.toEqual(doFront);
  });
});
