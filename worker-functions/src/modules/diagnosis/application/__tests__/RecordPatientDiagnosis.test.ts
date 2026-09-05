import { InMemoryTerminology } from '../../../terminology/infrastructure/InMemoryTerminology';
import { TerminologyUnavailableError } from '../../../terminology/domain/UnavailableTerminology';
import { IcdCode } from '../../../terminology/domain/IcdCode';
import type { DiagnosisEntity } from '../../../terminology/domain/TerminologyPort';
import { DiagnosisSource } from '../../domain/DiagnosisSource';
import {
  DuplicateActiveDiagnosisError,
  PrimaryDiagnosisConflictError,
} from '../../domain/PatientDiagnosisRepositoryPort';
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
  const terminology = new InMemoryTerminology(entities);
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

  /**
   * 🔧 F5-CORREÇÃO T6 (QA-caça, 05/09/2026) — o atalho `already_active` deixava ClickUp e banco
   * divergentes PARA SEMPRE.
   *
   * `ClickUpDiagnosisMapper` pede SEMPRE `isPrimary: true` — "Tipo de Patología" é seleção ÚNICA
   * no ClickUp. O `return` de `already_active` estava ANTES do bloco de reconciliação do
   * principal, então a sequência A→B→A terminava com o ClickUp dizendo A e o banco dizendo que o
   * principal é B. Logado em nível `info`, webhook 200, nenhuma linha de rejeição. Nenhum teste
   * cobria a VOLTA — só a ida.
   */
  describe('T6 — a VOLTA (A→B→A) não pode deixar o banco divergente da origem', () => {
    async function sequenciaAeBeA() {
      const { repo, useCase } = buildUseCase();
      repo.seedPatient(PATIENT_ID);
      const comoPrincipal = (conceptUri: string) =>
        useCase.execute({ patientId: PATIENT_ID, conceptUri, actorUid: 'clickup-sync', isPrimary: true });

      await comoPrincipal(AUTISM.uri); // (1) A vira principal
      await comoPrincipal(ONLY_ENGLISH.uri); // (2) B rebaixa A e vira principal — A segue ATIVA
      const volta = await comoPrincipal(AUTISM.uri); // (3) volta para A
      const linhas = await repo.listForPatient(PATIENT_ID);
      return { volta, linhas };
    }

    it('volta para A: o principal no banco volta a ser A (antes ficava B, calado)', async () => {
      const { volta, linhas } = await sequenciaAeBeA();

      expect(volta.outcome).toBe('already_active');
      const principais = linhas.filter((d) => d.isPrimary && d.active);
      expect(principais).toHaveLength(1);
      expect(principais[0].conceptUri).toBe(AUTISM.uri);
    });

    it('a reconciliação REBAIXA B — nunca ficam dois principais ativos na mesma origem', async () => {
      const { linhas } = await sequenciaAeBeA();
      const b = linhas.find((d) => d.conceptUri === ONLY_ENGLISH.uri)!;
      expect(b.isPrimary).toBe(false);
      expect(b.active).toBe(true); // rebaixar não é desativar
    });

    it('o outcome continua `already_active` — o 409 do painel não muda de forma', async () => {
      const { volta } = await sequenciaAeBeA();
      expect(volta.outcome).toBe('already_active');
      if (volta.outcome !== 'already_active') throw new Error('unreachable');
      expect(volta.diagnosis.isPrimary).toBe(true);
      expect(volta.diagnosis.updatedBy).toBe('clickup-sync');
    });

    it('já ativo e JÁ principal: idempotente, não reescreve nada', async () => {
      const { repo, useCase } = buildUseCase();
      repo.seedPatient(PATIENT_ID);
      const criado = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1', isPrimary: true });
      if (criado.outcome !== 'created') throw new Error('unreachable');
      const spy = jest.spyOn(repo, 'promotePrimary');

      const denovo = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-2', isPrimary: true });

      expect(denovo.outcome).toBe('already_active');
      if (denovo.outcome !== 'already_active') throw new Error('unreachable');
      expect(denovo.diagnosis.id).toBe(criado.diagnosis.id);
      expect(spy).not.toHaveBeenCalled();
    });

    it('já ativo e SEM isPrimary: continua sendo o atalho de leitura, sem escrever', async () => {
      const { repo, useCase } = buildUseCase();
      repo.seedPatient(PATIENT_ID);
      await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });
      const demote = jest.spyOn(repo, 'demotePrimary');

      const segundo = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });

      expect(segundo.outcome).toBe('already_active');
      expect(demote).not.toHaveBeenCalled();
    });
  });

  /**
   * 🔧 F5-CORREÇÃO T5 — o dedupe rodava FORA de transação (TOCTOU) e o 23505 do SEGUNDO índice
   * único da 325 não era mapeado: o perdedor de um webhook repetido / duplo clique recebia
   * HTTP 500 em vez de 409. A prova de CONCORRÊNCIA real está em
   * tests/e2e/t5-diagnosis-concurrency.e2e.test.ts (N rodadas contra o Postgres); aqui fica a
   * garantia estrutural — tudo dentro de UMA transação, atrás do lock, e o erro traduzido.
   */
  describe('T5 — dedupe dentro de transação, atrás do lock, com o 23505 do dedupe mapeado', () => {
    it('lockForPatient é a PRIMEIRA statement, antes de qualquer leitura de "existe?"', async () => {
      const { repo, useCase } = buildUseCase();
      repo.seedPatient(PATIENT_ID);
      const ordem: string[] = [];
      jest.spyOn(repo, 'lockForPatient').mockImplementation(async () => { ordem.push('lock'); });
      jest.spyOn(repo, 'findActiveByConceptCode').mockImplementation(async () => { ordem.push('find'); return null; });
      jest.spyOn(repo, 'create').mockImplementation(async () => { ordem.push('create'); return null as never; });

      await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });

      expect(ordem).toEqual(['lock', 'find', 'create']);
    });

    it('a criação SEM isPrimary também roda em transação (antes ia direto no pool, fora dela)', async () => {
      const { repo, useCase } = buildUseCase();
      repo.seedPatient(PATIENT_ID);
      const tx = jest.spyOn(repo, 'withTransaction');
      await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });
      expect(tx).toHaveBeenCalledTimes(1);
    });

    it('DuplicateActiveDiagnosisError vira outcome `duplicate_race` — NUNCA sobe cru (era o 500)', async () => {
      const { repo, useCase } = buildUseCase();
      repo.seedPatient(PATIENT_ID);
      jest.spyOn(repo, 'create').mockRejectedValueOnce(new DuplicateActiveDiagnosisError(PATIENT_ID));

      const result = await useCase.execute({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });

      expect(result.outcome).toBe('duplicate_race');
    });
  });
});
