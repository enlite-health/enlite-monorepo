import { DiagnosisSource } from '../../domain/DiagnosisSource';
import { InMemoryPatientDiagnosisRepository } from '../InMemoryPatientDiagnosisRepository';

describe('InMemoryPatientDiagnosisRepository — fake source-scoped (mesma física do adaptador real)', () => {
  it('promotePrimary lança quando o id não existe', async () => {
    const repo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
    await expect(repo.promotePrimary('nao-existe', 'uid-1')).rejects.toThrow(/não encontrado no escopo/);
  });

  it('promotePrimary lança quando o id existe mas é de OUTRA origem — escopo físico, não convenção', async () => {
    const panelRepo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
    panelRepo.seedPatient('p1');
    const created = await panelRepo.create({
      patientId: 'p1',
      conceptUri: 'uri-1',
      conceptCode: 'AA00',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    const sharedRows = (panelRepo as unknown as { rows: Map<string, unknown> }).rows;
    const clickupRepo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.CLICKUP, sharedRows as never, new Set(['p1']));
    await expect(clickupRepo.promotePrimary(created.id, 'uid-1')).rejects.toThrow(/não encontrado no escopo/);
  });

  it('deactivate lança quando o id não existe', async () => {
    const repo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
    await expect(repo.deactivate('nao-existe', 'uid-1')).rejects.toThrow(/não encontrado no escopo/);
  });

  it('deactivate lança quando o id existe mas é de OUTRA origem', async () => {
    const panelRepo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
    panelRepo.seedPatient('p1');
    const created = await panelRepo.create({
      patientId: 'p1',
      conceptUri: 'uri-1',
      conceptCode: 'AA00',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    const sharedRows = (panelRepo as unknown as { rows: Map<string, unknown> }).rows;
    const clickupRepo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.CLICKUP, sharedRows as never, new Set(['p1']));
    await expect(clickupRepo.deactivate(created.id, 'uid-1')).rejects.toThrow(/não encontrado no escopo/);
  });

  it('findActiveByConceptCode ignora linha ATIVA de OUTRA origem com o MESMO código', async () => {
    const panelRepo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.PANEL);
    panelRepo.seedPatient('p1');
    await panelRepo.create({
      patientId: 'p1',
      conceptUri: 'uri-1',
      conceptCode: 'AA00',
      conceptTitle: 'x',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      isPrimary: false,
      actorUid: 'uid-1',
    });
    const sharedRows = (panelRepo as unknown as { rows: Map<string, unknown> }).rows;
    const clickupRepo = new InMemoryPatientDiagnosisRepository(DiagnosisSource.CLICKUP, sharedRows as never, new Set(['p1']));
    expect(await clickupRepo.findActiveByConceptCode('p1', 'AA00')).toBeNull();
  });
});
