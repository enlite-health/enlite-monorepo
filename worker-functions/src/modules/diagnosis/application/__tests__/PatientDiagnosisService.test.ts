import { InMemoryTerminology } from '../../../terminology/infrastructure/InMemoryTerminology';
import { IcdCode } from '../../../terminology/domain/IcdCode';
import type { DiagnosisEntity } from '../../../terminology/domain/TerminologyPort';
import { DiagnosisSource } from '../../domain/DiagnosisSource';
import { InMemoryPatientDiagnosisRepository } from '../../infrastructure/InMemoryPatientDiagnosisRepository';
import { PatientDiagnosisService } from '../PatientDiagnosisService';

const CHAPTER: DiagnosisEntity = {
  uri: 'chapter-06', code: IcdCode.parse('06'), titleEs: 'Trastornos mentales', titleEn: 'Mental disorders',
  chapter: '06', release: '2026-01', kind: 'chapter', isLeaf: false, parentUri: null,
};
const AUTISM: DiagnosisEntity = {
  uri: 'autism-uri', code: IcdCode.parse('6A02.Z'), titleEs: 'Trastorno del espectro autista', titleEn: 'ASD',
  chapter: '06', release: '2026-01', kind: 'stem', isLeaf: true, parentUri: null,
};

const PATIENT_ID = 'patient-1';

function buildFacade() {
  const terminology = new InMemoryTerminology([AUTISM, CHAPTER]);
  const repo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
  repo.seedPatient(PATIENT_ID);
  const facade = new PatientDiagnosisService(terminology, repo);
  return { facade, repo };
}

describe('PatientDiagnosisService — Facade, porta de entrada ÚNICA (spec 016 F2, "Contrato de arquitetura")', () => {
  it('recordDiagnosis delega ao caso de uso RecordPatientDiagnosis', async () => {
    const { facade } = buildFacade();
    const result = await facade.recordDiagnosis({ patientId: PATIENT_ID, conceptUri: AUTISM.uri, actorUid: 'uid-1' });
    expect(result.outcome).toBe('created');
  });

  it('setPrimary delega ao caso de uso SetPrimaryDiagnosis', async () => {
    const { facade, repo } = buildFacade();
    const created = await repo.create({
      patientId: PATIENT_ID, conceptUri: 'x', conceptCode: 'AA00',
      conceptTitle: 'x', conceptLanguage: 'es', conceptGroup: '06', catalogRelease: '2026-01',
      isPrimary: false, actorUid: 'uid-1',
    });
    const result = await facade.setPrimary(PATIENT_ID, created.id, 'uid-2');
    expect(result.outcome).toBe('ok');
  });

  it('deactivate delega ao caso de uso DeactivatePatientDiagnosis', async () => {
    const { facade, repo } = buildFacade();
    const created = await repo.create({
      patientId: PATIENT_ID, conceptUri: 'x', conceptCode: 'AA00',
      conceptTitle: 'x', conceptLanguage: 'es', conceptGroup: '06', catalogRelease: '2026-01',
      isPrimary: false, actorUid: 'uid-1',
    });
    const result = await facade.deactivate(PATIENT_ID, created.id, 'uid-2');
    expect(result.outcome).toBe('ok');
  });

  it('listForPatient: found=false quando o paciente não existe; found=true com diagnoses[] quando existe', async () => {
    const { facade, repo } = buildFacade();
    const missing = await facade.listForPatient('fantasma');
    expect(missing.found).toBe(false);

    await repo.create({
      patientId: PATIENT_ID, conceptUri: 'x', conceptCode: 'AA00',
      conceptTitle: 'x', conceptLanguage: 'es', conceptGroup: '06', catalogRelease: '2026-01',
      isPrimary: false, actorUid: 'uid-1',
    });
    const found = await facade.listForPatient(PATIENT_ID);
    expect(found.found).toBe(true);
    if (!found.found) throw new Error('unreachable');
    expect(found.diagnoses).toHaveLength(1);
  });
});
