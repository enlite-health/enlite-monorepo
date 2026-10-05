import { loadPublicVacancyDiagnosisLabel } from '../publicVacancyDiagnosisLabel';
import { DiagnosisSource } from '@modules/diagnosis/domain/DiagnosisSource';
import type { PatientDiagnosisService } from '@modules/diagnosis/application/PatientDiagnosisService';
import * as logging from '@shared/logging';

const TITULO = 'Diagnóstico sintético QA';
const VACANCY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PATIENT_ID = '11111111-2222-3333-4444-555555555555';

function row(o: Record<string, unknown> = {}) {
  return {
    conceptTitle: TITULO,
    conceptLanguage: 'es',
    conceptCode: 'ZZ99.Z',
    source: DiagnosisSource.PANEL,
    isPrimary: true,
    active: true,
    ...o,
  };
}

function svc(impl: () => Promise<unknown>): { service: PatientDiagnosisService; listForPatient: jest.Mock } {
  const listForPatient = jest.fn(impl);
  return { service: { listForPatient } as unknown as PatientDiagnosisService, listForPatient };
}

describe('loadPublicVacancyDiagnosisLabel (spec 042)', () => {
  let reportSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let consoleErr: jest.SpyInstance;
  let consoleLog: jest.SpyInstance;

  beforeEach(() => {
    reportSpy = jest.spyOn(logging, 'reportError').mockImplementation(() => undefined as never);
    infoSpy = jest.spyOn(logging.logger, 'info').mockImplementation((() => undefined) as never);
    warnSpy = jest.spyOn(logging.logger, 'warn').mockImplementation((() => undefined) as never);
    errSpy = jest.spyOn(logging.logger, 'error').mockImplementation((() => undefined) as never);
    consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const tudoQueFoiParaLog = () =>
    JSON.stringify([
      reportSpy.mock.calls,
      infoSpy.mock.calls,
      warnSpy.mock.calls,
      errSpy.mock.calls,
      consoleErr.mock.calls,
      consoleLog.mock.calls,
    ]);

  it('caminho feliz: devolve o título e NADA do rótulo vai a log/reportError (A5)', async () => {
    const { service } = svc(async () => ({ found: true, diagnoses: [row()] }));
    const label = await loadPublicVacancyDiagnosisLabel(() => service, PATIENT_ID, VACANCY_ID);
    expect(label).toBe(TITULO);
    expect(reportSpy).not.toHaveBeenCalled();
    expect(tudoQueFoiParaLog()).not.toContain(TITULO);
    expect(tudoQueFoiParaLog()).not.toContain('ZZ99');
  });

  it('serviço lança → null + reportError 1x só com {source, vacancyId}, sem patientId nem título (A5)', async () => {
    const { service } = svc(async () => {
      throw new Error('catálogo fora do ar');
    });
    const label = await loadPublicVacancyDiagnosisLabel(() => service, PATIENT_ID, VACANCY_ID);
    expect(label).toBeNull();
    expect(reportSpy).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportSpy.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toEqual({ source: 'PublicVacancyController:diagnosisLabel', vacancyId: VACANCY_ID });
    expect(tudoQueFoiParaLog()).not.toContain(TITULO);
    expect(tudoQueFoiParaLog()).not.toContain(PATIENT_ID);
  });

  it('getService lança (env inválida) → null + reportError, não propaga (A5)', async () => {
    const label = await loadPublicVacancyDiagnosisLabel(
      () => {
        throw new Error('TERMINOLOGY_ADAPTER inválido');
      },
      PATIENT_ID,
      VACANCY_ID,
    );
    expect(label).toBeNull();
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][1]).toEqual({ source: 'PublicVacancyController:diagnosisLabel', vacancyId: VACANCY_ID });
  });

  it('sem patientId → null sem chamar o serviço (nem a fábrica)', async () => {
    const { service, listForPatient } = svc(async () => ({ found: true, diagnoses: [row()] }));
    const getService = jest.fn(() => service);
    expect(await loadPublicVacancyDiagnosisLabel(getService, null, VACANCY_ID)).toBeNull();
    expect(await loadPublicVacancyDiagnosisLabel(getService, undefined, VACANCY_ID)).toBeNull();
    expect(getService).not.toHaveBeenCalled();
    expect(listForPatient).not.toHaveBeenCalled();
  });

  it('found:false → null', async () => {
    const { service } = svc(async () => ({ found: false }));
    expect(await loadPublicVacancyDiagnosisLabel(() => service, PATIENT_ID, VACANCY_ID)).toBeNull();
  });

  it('2+ ativos sem principal → null (usa a seleção compartilhada)', async () => {
    const { service } = svc(async () => ({
      found: true,
      diagnoses: [row({ isPrimary: false }), row({ isPrimary: false, conceptTitle: 'Outro sintético' })],
    }));
    expect(await loadPublicVacancyDiagnosisLabel(() => service, PATIENT_ID, VACANCY_ID)).toBeNull();
  });
});
