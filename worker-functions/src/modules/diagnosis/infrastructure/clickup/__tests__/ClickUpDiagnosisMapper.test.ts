/**
 * ClickUpDiagnosisMapper — spec 016 F4. Adapter que resolve o rótulo CRU de "Tipo de
 * Patología" (ClickUp) contra `clickup_diagnosis_labels` e grava via `PatientDiagnosisService`
 * (Facade), usando um repositório JÁ ESCOPADO a `DiagnosisSource.CLICKUP` por construtor —
 * este arquivo NUNCA decide origem por `if`, e o teste abaixo prova isso pelo grep (ver
 * `tests/unit/__tests__/f4-sem-if-de-origem.test.ts`).
 *
 * Unitário e puro: `labels`/`rejections`/`service` são fakes injetados — nenhum banco real
 * aqui. A prova com Postgres real é o e2e (`tests/e2e/clickup-diagnosis-sync.e2e.test.ts`).
 */
import { ClickUpDiagnosisMapper } from '../ClickUpDiagnosisMapper';
import type { ClickUpDiagnosisLabelPort } from '../ClickUpDiagnosisLabelRepository';
import type { ClickUpDiagnosisRejectionPort } from '../ClickUpDiagnosisRejectionRepository';
import type { PatientDiagnosisService } from '../../../application/PatientDiagnosisService';

function makeService(outcome: unknown): PatientDiagnosisService {
  return { recordDiagnosis: jest.fn().mockResolvedValue(outcome) } as unknown as PatientDiagnosisService;
}

function makeLabels(resolved: string | null): ClickUpDiagnosisLabelPort {
  return { resolve: jest.fn().mockResolvedValue(resolved) };
}

function makeRejections(): ClickUpDiagnosisRejectionPort {
  return {
    recordUnmapped:   jest.fn().mockResolvedValue(undefined),
    recordUnreadable: jest.fn().mockResolvedValue(undefined),
  };
}

describe('ClickUpDiagnosisMapper', () => {
  it('sem rótulo (campo vazio no ClickUp): não resolve, não grava, não registra recusa', async () => {
    const labels = makeLabels(null);
    const rejections = makeRejections();
    const service = makeService({ outcome: 'created' });
    const mapper = new ClickUpDiagnosisMapper(labels, rejections, service);

    const result = await mapper.syncFromLabel('pat-1', null);

    expect(result).toEqual({ kind: 'no_label' });
    expect(labels.resolve).not.toHaveBeenCalled();
    expect(rejections.recordUnmapped).not.toHaveBeenCalled();
    expect(service.recordDiagnosis).not.toHaveBeenCalled();
  });

  it('rótulo MAPEADO: resolve a URI e grava via o Facade, sempre como principal', async () => {
    const labels = makeLabels('http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified');
    const rejections = makeRejections();
    const service = makeService({ outcome: 'created', diagnosis: { id: 'diag-1' } });
    const mapper = new ClickUpDiagnosisMapper(labels, rejections, service);

    const result = await mapper.syncFromLabel('pat-1', 'Trastorno del Espectro Autista');

    expect(labels.resolve).toHaveBeenCalledWith('Trastorno del Espectro Autista');
    expect(service.recordDiagnosis).toHaveBeenCalledWith({
      patientId: 'pat-1',
      conceptUri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified',
      isPrimary: true,
      actorUid: 'clickup-sync',
    });
    expect(rejections.recordUnmapped).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'synced', outcome: 'created' });
  });

  it('rótulo NÃO MAPEADO: registra a recusa (durável) e NÃO chama o Facade — nunca inventa', async () => {
    const labels = makeLabels(null);
    const rejections = makeRejections();
    const service = makeService({ outcome: 'created' });
    const mapper = new ClickUpDiagnosisMapper(labels, rejections, service);

    const result = await mapper.syncFromLabel('pat-1', 'Rótulo Nunca Visto Antes');

    expect(labels.resolve).toHaveBeenCalledWith('Rótulo Nunca Visto Antes');
    expect(rejections.recordUnmapped).toHaveBeenCalledWith('pat-1', 'Rótulo Nunca Visto Antes');
    expect(service.recordDiagnosis).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'unmapped' });
  });

  it('propaga o outcome exato do Facade (ex.: already_active) sem reinterpretar', async () => {
    const labels = makeLabels('uri://x');
    const rejections = makeRejections();
    const service = makeService({ outcome: 'already_active', diagnosis: { id: 'diag-1' } });
    const mapper = new ClickUpDiagnosisMapper(labels, rejections, service);

    const result = await mapper.syncFromLabel('pat-1', 'Parálisis Cerebral');

    expect(result).toEqual({ kind: 'synced', outcome: 'already_active' });
  });

  // ── I3b (migration 329): a leitura ILEGÍVEL fica em LISTA, sem o valor ───────────────────
  it('ILEGÍVEL: registra a OCORRÊNCIA sem valor, não resolve o mapa e não chama o Facade', async () => {
    const labels = makeLabels('uri://x');
    const rejections = makeRejections();
    const service = makeService({ outcome: 'created' });
    const mapper = new ClickUpDiagnosisMapper(labels, rejections, service);

    const result = await mapper.recordUnreadableLabel('pat-1');

    expect(result).toEqual({ kind: 'unreadable' });
    // A trava é a ASSINATURA: o orderindex não atravessa esta fronteira nem por engano.
    expect(rejections.recordUnreadable).toHaveBeenCalledWith('pat-1');
    expect(rejections.recordUnmapped).not.toHaveBeenCalled();
    expect(labels.resolve).not.toHaveBeenCalled();
    expect(service.recordDiagnosis).not.toHaveBeenCalled();
  });
});
