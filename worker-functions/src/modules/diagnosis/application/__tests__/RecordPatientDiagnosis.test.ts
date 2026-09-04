import { InMemoryTerminology } from '../../../terminology/infrastructure/InMemoryTerminology';
import { TerminologyUnavailableError } from '../../../terminology/domain/UnavailableTerminology';
import { IcdCode } from '../../../terminology/domain/IcdCode';
import type { DiagnosisEntity } from '../../../terminology/domain/TerminologyPort';
import { DiagnosisSource } from '../../domain/DiagnosisSource';
import { PrimaryDiagnosisConflictError } from '../../domain/PatientDiagnosisRepositoryPort';
import { InMemoryPatientDiagnosisRepository } from '../../infrastructure/InMemoryPatientDiagnosisRepository';
import { RecordPatientDiagnosis } from '../RecordPatientDiagnosis';

const CHAPTER: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/chapter06',
  code: IcdCode.parse('06'),
  titleEs: 'Trastornos mentales',
  titleEn: 'Mental disorders',
  chapter: '06',
  release: '2026-01',
  kind: 'chapter',
  isLeaf: false,
  parentUri: null,
};

const AUTISM: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/6A02',
  code: IcdCode.parse('6A02.Z'),
  titleEs: 'Trastorno del espectro autista',
  titleEn: 'Autism spectrum disorder',
  chapter: '06',
  release: '2026-01',
  kind: 'stem',
  isLeaf: true,
  parentUri: null,
};

/** Sem título em espanhol — release 2026-01 tem buracos de tradução (F0). */
const ONLY_ENGLISH: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/only-en',
  code: IcdCode.parse('8A62.Z'),
  titleEs: null,
  titleEn: 'Some untranslated concept',
  chapter: '08',
  release: '2026-01',
  kind: 'stem',
  isLeaf: true,
  parentUri: null,
};

/** C3 (QA-caça) — código de extensão (ex.: "Plomo", XM0ZH6): resolve no catálogo, não é diagnóstico. */
const LEAD_EXTENSION: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/extension/lead',
  code: IcdCode.parse('XM0ZH6'),
  titleEs: 'Plomo',
  titleEn: 'Lead',
  chapter: '22',
  release: '2026-01',
  kind: 'extension',
  isLeaf: true,
  parentUri: null,
};

const ONLY_ENGLISH_CHAPTER: DiagnosisEntity = {
  uri: 'http://id.who.int/icd/release/11/2026-01/mms/chapter08',
  code: IcdCode.parse('08'),
  titleEs: 'Enfermedades del sistema nervioso',
  titleEn: 'Diseases of the nervous system',
  chapter: '08',
  release: '2026-01',
  kind: 'chapter',
  isLeaf: false,
  parentUri: null,
};

function buildUseCase(entities: DiagnosisEntity[] = [AUTISM, CHAPTER, ONLY_ENGLISH, ONLY_ENGLISH_CHAPTER, LEAD_EXTENSION]) {
  const terminology = new InMemoryTerminology(entities, { currentRelease: '2026-01' });
  const repo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
  const useCase = new RecordPatientDiagnosis(terminology, repo);
  return { terminology, repo, useCase };
}

const PATIENT_ID = 'patient-1';

describe('RecordPatientDiagnosis — caso de uso (spec 016 F2)', () => {
  it('patient_not_found quando o paciente não existe', async () => {
    const { useCase } = buildUseCase();
    const result = await useCase.execute({ patientId: 'ghost', conceptUri: AUTISM.uri, actorUid: 'uid-1' });
    expect(result.outcome).toBe('patient_not_found');
  });

  it('concept_not_resolved (base do 422) quando a URI não resolve no catálogo', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: 'http://nao-existe', actorUid: 'uid-1' });
    expect(result.outcome).toBe('concept_not_resolved');
  });

  it('grava o CÓDIGO INTEIRO, título/idioma resolvidos e o capítulo como concept_group — nunca sabe que existe OMS', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-7' });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('unreachable');
    expect(result.diagnosis.conceptCode.value).toBe('6A02.Z');
    expect(result.diagnosis.conceptTitle).toBe('Trastorno del espectro autista');
    expect(result.diagnosis.conceptLanguage).toBe('es');
    expect(result.diagnosis.conceptGroup).toBe('06');
    expect(result.diagnosis.catalogRelease).toBe('2026-01');
    expect(result.diagnosis.terminologySystem).toBe('ICD-11');
    expect(result.diagnosis.isPrimary).toBe(false);
    expect(result.diagnosis.createdBy).toBe('uid-7');
  });

  it('cai para inglês e GRAVA concept_language=en quando o release não tem título em espanhol (buraco de tradução, F0)', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: ONLY_ENGLISH.uri, actorUid: 'uid-1' });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('unreachable');
    expect(result.diagnosis.conceptTitle).toBe('Some untranslated concept');
    expect(result.diagnosis.conceptLanguage).toBe('en');
  });

  it('already_active (base do 409) quando o MESMO código já está ativo nesta origem — dedupe por CÓDIGO', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    const first = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });
    expect(first.outcome).toBe('created');
    const second = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });
    expect(second.outcome).toBe('already_active');
  });

  it('isPrimary=true na criação grava como principal', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1', isPrimary: true });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('unreachable');
    expect(result.diagnosis.isPrimary).toBe(true);
  });

  it('C3 (QA-caça) — not_diagnosable quando a URI resolve para CAPÍTULO (kind=chapter): a busca já exclui, a escrita repete a regra', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: CHAPTER.uri, actorUid: 'uid-1' });
    expect(result.outcome).toBe('not_diagnosable');
  });

  it('C3 (QA-caça) — not_diagnosable quando a URI resolve para EXTENSÃO (kind=extension, ex.: "Plomo")', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: LEAD_EXTENSION.uri, actorUid: 'uid-1' });
    expect(result.outcome).toBe('not_diagnosable');
  });

  it('C1 (QA-caça) — PrimaryDiagnosisConflictError na criação COM isPrimary:true vira outcome primary_race, nunca sobe cru', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    jest.spyOn(repo, 'withTransaction').mockRejectedValueOnce(new PrimaryDiagnosisConflictError(PATIENT_ID));
    const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1', isPrimary: true });
    expect(result.outcome).toBe('primary_race');
  });

  it('propaga qualquer OUTRO erro da criação COM isPrimary:true intacto (não é engolido pelo catch do primary_race)', async () => {
    const { repo, useCase } = buildUseCase();
    repo.seedPatient(PATIENT_ID);
    jest.spyOn(repo, 'withTransaction').mockRejectedValueOnce(new Error('conexão perdida'));
    await expect(
      useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1', isPrimary: true }),
    ).rejects.toThrow('conexão perdida');
  });

  it('US-4: propaga TerminologyUnavailableError em voz alta — nunca cai para sucesso silencioso', async () => {
    const repo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
    repo.seedPatient(PATIENT_ID);
    const { UnavailableTerminology } = await import('../../../terminology/domain/UnavailableTerminology');
    const useCase = new RecordPatientDiagnosis(new UnavailableTerminology('teste'), repo);
    await expect(
      useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' }),
    ).rejects.toThrow(TerminologyUnavailableError);
  });
});
