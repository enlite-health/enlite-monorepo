import { DiagnosisSource } from '../../domain/DiagnosisSource';
import { InMemoryPatientDiagnosisRepository } from '../../infrastructure/InMemoryPatientDiagnosisRepository';
import { SetPrimaryDiagnosis } from '../SetPrimaryDiagnosis';

const PATIENT_ID = 'patient-1';

function buildRepo() {
  const repo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
  repo.seedPatient(PATIENT_ID);
  return repo;
}

describe('SetPrimaryDiagnosis — reconcilia rebaixar A + promover B na MESMA transação (D263)', () => {
  it('not_found quando o id não existe', async () => {
    const repo = buildRepo();
    const useCase = new SetPrimaryDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, 'nao-existe', 'uid-x');
    expect(result.outcome).toBe('not_found');
  });

  it('not_found (404) quando o diagnóstico é de OUTRO paciente', async () => {
    const repo = buildRepo();
    repo.seedPatient('outro-paciente');
    const foreign = await repo.create({
      patientId: 'outro-paciente',
      conceptUri: 'uri-1',
      conceptCode: '6A02.Z',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    const useCase = new SetPrimaryDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, foreign.id, 'uid-x');
    expect(result.outcome).toBe('not_found');
  });

  it('conflict (409) ao promover um diagnóstico INATIVO', async () => {
    const repo = buildRepo();
    const created = await repo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-1',
      conceptCode: '6A02.Z',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    await repo.deactivate(created.id, 'uid-1');
    const useCase = new SetPrimaryDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, created.id, 'uid-x');
    expect(result.outcome).toBe('conflict');
  });

  it('idempotente: promover quem já é o principal devolve ok sem tocar em nada', async () => {
    const repo = buildRepo();
    const created = await repo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-1',
      conceptCode: '6A02.Z',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: true,
      actorUid: 'uid-1',
    });
    const useCase = new SetPrimaryDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, created.id, 'uid-x');
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') throw new Error('unreachable');
    expect(result.diagnosis.isPrimary).toBe(true);
  });

  it('troca de principal: rebaixa A e promove B — nunca dois principais, nunca 23505 (item 3 dos 8 testes)', async () => {
    const repo = buildRepo();
    const a = await repo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-a',
      conceptCode: 'AA00',
      conceptTitle: 'A',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: true,
      actorUid: 'uid-1',
    });
    const b = await repo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-b',
      conceptCode: 'AA01',
      conceptTitle: 'B',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    const useCase = new SetPrimaryDiagnosis(repo);
    const result = await useCase.execute(PATIENT_ID, b.id, 'uid-x');
    expect(result.outcome).toBe('ok');

    const all = await repo.listForPatient(PATIENT_ID);
    const primaries = all.filter((d) => d.isPrimary && d.active);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(b.id);
    const reloadedA = await repo.findById(a.id);
    expect(reloadedA?.isPrimary).toBe(false);
  });

  it('o espelho do ClickUp (outra origem) NUNCA enxerga nem rebaixa o principal do painel (teste 2 dos 8)', async () => {
    const panelRepo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
    panelRepo.seedPatient(PATIENT_ID);
    const panelPrimary = await panelRepo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-panel',
      conceptCode: 'AA02',
      conceptTitle: 'Panel',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: true,
      actorUid: 'panel-uid',
    });

    // Mesmo Map de linhas, mas um repositório ESCOPADO em CLICKUP — a "física" do escopo.
    const sharedRowsAccessor = panelRepo as unknown as { rows: Map<string, unknown> };
    const clickupRepo = new InMemoryPatientDiagnosisRepository(
      DiagnosisSource.CLICKUP,
      sharedRowsAccessor.rows as never,
      new Set([PATIENT_ID]),
    );
    const clickupOwn = await clickupRepo.create({
      patientId: PATIENT_ID,
      conceptUri: 'uri-clickup',
      conceptCode: 'AA03',
      conceptTitle: 'ClickUp',
      conceptLanguage: 'es',
      conceptGroup: '08',
      catalogRelease: '2026-01',
      isPrimary: true,
      actorUid: 'clickup-sync',
    });

    // O repo do ClickUp nem ENXERGA o diagnóstico do painel (findById devolve null fora do escopo).
    expect(await clickupRepo.findById(panelPrimary.id)).toBeNull();

    const clickupUseCase = new SetPrimaryDiagnosis(clickupRepo);
    const result = await clickupUseCase.execute(PATIENT_ID, clickupOwn.id, 'uid-x');
    expect(result.outcome).toBe('ok');

    const panelStillPrimary = await panelRepo.findById(panelPrimary.id);
    expect(panelStillPrimary?.isPrimary).toBe(true);
    expect(panelStillPrimary?.active).toBe(true);
  });
});
