import { DiagnosisSource } from '../../domain/DiagnosisSource';
import { InMemoryPatientDiagnosisRepository } from '../../infrastructure/InMemoryPatientDiagnosisRepository';
import { DeactivatePatientDiagnosis } from '../DeactivatePatientDiagnosis';

const PATIENT_ID = 'patient-1';

function buildRepo() {
  const repo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
  repo.seedPatient(PATIENT_ID);
  return repo;
}

describe('DeactivatePatientDiagnosis — baixa é active=false + ended_at, NUNCA DELETE (spec 016 F2)', () => {
  it('not_found (404) quando o id não existe', async () => {
    const repo = buildRepo();
    const useCase = new DeactivatePatientDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, 'nao-existe', 'uid-x');
    expect(result.outcome).toBe('not_found');
  });

  it('not_found (404 cross-patient) quando o diagnóstico é de outro paciente', async () => {
    const repo = buildRepo();
    repo.seedPatient('outro-paciente');
    const foreign = await repo.create({
      patientId: 'outro-paciente',
      conceptUri: 'uri-1',
      conceptCode: 'AA00',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    const useCase = new DeactivatePatientDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, foreign.id, 'uid-x');
    expect(result.outcome).toBe('not_found');
  });

  it('conflict (409) ao desativar de novo um diagnóstico já inativo — nunca uma 2ª baixa silenciosa', async () => {
    const repo = buildRepo();
    const created = await repo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-1',
      conceptCode: 'AA00',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    const useCase = new DeactivatePatientDiagnosis(repo);
    const first = await useCase.execute(PATIENT_ID, created.id, 'uid-x');
    expect(first.outcome).toBe('ok');
    const second = await useCase.execute(PATIENT_ID, created.id, 'uid-x');
    expect(second.outcome).toBe('conflict');
  });

  it('desativa um principal: active=false, ended_at preenchido e isPrimary rebaixado junto (CHECK pd_primary_so_se_ativo)', async () => {
    const repo = buildRepo();
    const created = await repo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-1',
      conceptCode: 'AA00',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: true,
      actorUid: 'uid-1',
    });
    const useCase = new DeactivatePatientDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, created.id, 'uid-9');
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.diagnosis.active).toBe(false);
    expect(result.diagnosis.isPrimary).toBe(false);
    expect(result.diagnosis.endedAt).not.toBeNull();
    expect(result.diagnosis.updatedBy).toBe('uid-9');
  });
});
