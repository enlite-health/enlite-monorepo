import { IcdCode } from '../../../terminology/domain/IcdCode';
import { DiagnosisSource } from '../../domain/DiagnosisSource';
import { PatientDiagnosis } from '../../domain/PatientDiagnosis';
import { toDiagnosisPublicView } from '../DiagnosisPublicView';

describe('DiagnosisPublicView — fronteira REQ-21: code/group/release NUNCA no JSON', () => {
  it('projeta só {id, uri, title, isPrimary, source, active} — nenhuma chave de vocabulário', () => {
    const d = PatientDiagnosis.reconstruct({
      id: 'd1',
      patientId: 'p1',
      terminologySystem: 'ICD-11',
      conceptUri: 'http://id.who.int/icd/release/11/2026-01/mms/6A02',
      conceptCode: IcdCode.parse('6A02.Z'),
      conceptTitle: 'Trastorno del espectro autista',
      conceptLanguage: 'es',
      conceptGroup: '06',
      catalogRelease: '2026-01',
      source: DiagnosisSource.PANEL,
      isPrimary: true,
      active: true,
      endedAt: null,
      country: 'AR',
      createdBy: 'uid-1',
      updatedBy: 'uid-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const view = toDiagnosisPublicView(d);
    expect(view).toEqual({
      id: 'd1',
      uri: 'http://id.who.int/icd/release/11/2026-01/mms/6A02',
      title: 'Trastorno del espectro autista',
      isPrimary: true,
      source: 'PANEL',
      active: true,
    });
    const keys = Object.keys(view);
    expect(keys).not.toContain('code');
    expect(keys).not.toContain('chapter');
    expect(keys).not.toContain('release');
    expect(keys).not.toContain('conceptCode');
    expect(keys).not.toContain('conceptGroup');
    expect(keys).not.toContain('catalogRelease');
    // O código (cluster inteiro) nunca aparece em lugar NENHUM do JSON — nem dentro da URI.
    expect(JSON.stringify(view)).not.toContain('6A02.Z');
  });
});
