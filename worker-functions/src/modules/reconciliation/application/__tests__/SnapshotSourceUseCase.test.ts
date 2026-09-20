/**
 * SnapshotSourceUseCase — H1: completude MEDIDA, hash igual não grava,
 * canonical proibido (C2) não entra e vira PARTIAL, reader que estoura → FAILED.
 * Fixture sintética.
 */
// ── Mocks (before imports) ──
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn() },
}));

import { SnapshotSourceUseCase, completenessOf } from '../SnapshotSourceUseCase';
import { ForbiddenCanonicalError } from '../../infrastructure/SnapshotRepository';
import type { PatientSourceReader, SourceReadResult } from '../../domain/PatientSourceReader';
import type { CanonicalPatient } from '../../domain/CanonicalPatient';

const canon = (n: string): CanonicalPatient => ({
  firstName: n, lastName: 'X', birthDate: '2010-01-01', documentType: null, documentNumber: null, sex: null,
  phoneWhatsapp: null, healthInsuranceName: null, healthInsuranceMemberId: null, hasCud: null, hasConsent: null,
  hasJudicialProtection: null, diagnosis: null, dependencyLevel: null, clinicalSpecialty: null, serviceType: null,
  additionalComments: null, province: null, cityLocality: null, zoneNeighborhood: null, addresses: [],
  multidisciplinaryTeam: null, caseNumber: null, status: null, responsibleFirstName: null, responsibleLastName: null,
  responsibleRelationship: null, country: 'AR',
});

function reader(read: Partial<SourceReadResult> | (() => Promise<SourceReadResult>)): PatientSourceReader {
  return {
    source: 'CLICKUP', country: 'AR',
    read: typeof read === 'function' ? read : async () => ({
      source: 'CLICKUP', country: 'AR', records: [], expectedCount: 0, readCount: 0, skipped: [], ...read,
    }),
  };
}

function deps(writeOutcomes: Array<'CREATED' | 'REPLACED' | 'UNCHANGED' | Error> = []) {
  let i = 0;
  const runs = {
    start: jest.fn().mockResolvedValue({ id: 'run-1', source: 'CLICKUP', country: 'AR' }),
    finish: jest.fn().mockImplementation(async (_id: string, input: unknown) => ({ id: 'run-1', ...(input as object) })),
  };
  const snapshots = {
    writeIfChanged: jest.fn().mockImplementation(async () => {
      const o = writeOutcomes[i++] ?? 'CREATED';
      if (o instanceof Error) throw o;
      return o;
    }),
  };
  return { runs, snapshots };
}

describe('completenessOf', () => {
  it('COMPLETE quando read == expected e nada pulado', () => {
    expect(completenessOf({ source: 'CLICKUP', country: 'AR', records: [], expectedCount: 3, readCount: 3, skipped: [] })).toBe('COMPLETE');
  });
  it('PARTIAL quando read < expected — nunca apresentada como completa', () => {
    expect(completenessOf({ source: 'CLICKUP', country: 'AR', records: [], expectedCount: 12, readCount: 10, skipped: [] })).toBe('PARTIAL');
  });
  it('PARTIAL quando houve pulados ou barrados por C2', () => {
    expect(completenessOf({ source: 'CLICKUP', country: 'AR', records: [], expectedCount: 1, readCount: 1, skipped: [{ externalId: 'x', reason: 'no_name' }] })).toBe('PARTIAL');
    expect(completenessOf({ source: 'CLICKUP', country: 'AR', records: [], expectedCount: 1, readCount: 1, skipped: [] }, 1)).toBe('PARTIAL');
  });
  it('FAILED com erro fatal', () => {
    expect(completenessOf({ source: 'CLICKUP', country: 'AR', records: [], expectedCount: null, readCount: 0, skipped: [], fatalError: 'x' })).toBe('FAILED');
  });
});

describe('SnapshotSourceUseCase.execute', () => {
  it('grava um snapshot por registro e fecha COMPLETE', async () => {
    const d = deps(['CREATED', 'REPLACED', 'UNCHANGED']);
    const uc = new SnapshotSourceUseCase(d);
    const r = await uc.execute({
      reader: reader({ records: [
        { externalId: 'a', canonical: canon('a') }, { externalId: 'b', canonical: canon('b') }, { externalId: 'c', canonical: canon('c') },
      ], expectedCount: 3, readCount: 3 }),
      triggeredBy: 'MANUAL',
    });
    expect(d.snapshots.writeIfChanged).toHaveBeenCalledTimes(3);
    expect(r.counters).toEqual({ CREATED: 1, REPLACED: 1, UNCHANGED: 1, skipped: 0, forbidden: 0 });
    expect(d.runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ completeness: 'COMPLETE', readCount: 3, expectedCount: 3 }));
  });

  it('gateway devolve 10, lista diz 12 → PARTIAL', async () => {
    const d = deps();
    const uc = new SnapshotSourceUseCase(d);
    const recs = Array.from({ length: 10 }, (_, i) => ({ externalId: `t${i}`, canonical: canon(`n${i}`) }));
    const r = await uc.execute({ reader: reader({ records: recs, expectedCount: 12, readCount: 10 }), triggeredBy: 'SCHEDULER' });
    expect(r.run.completeness).toBe('PARTIAL');
  });

  it('canonical proibido (C2) não entra: conta em forbidden, rodada PARTIAL, os outros seguem', async () => {
    const d = deps(['CREATED', new ForbiddenCanonicalError('b'), 'CREATED']);
    const uc = new SnapshotSourceUseCase(d);
    const r = await uc.execute({
      reader: reader({ records: [
        { externalId: 'a', canonical: canon('a') }, { externalId: 'b', canonical: canon('b') }, { externalId: 'c', canonical: canon('c') },
      ], expectedCount: 3, readCount: 3 }),
      triggeredBy: 'MANUAL',
    });
    expect(r.counters.forbidden).toBe(1);
    expect(r.counters.CREATED).toBe(2);
    expect(r.run.completeness).toBe('PARTIAL');
    expect(d.runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ readCount: 2 }));
  });

  it('erro fatal do leitor → FAILED, nada gravado, error sem dado', async () => {
    const d = deps();
    const uc = new SnapshotSourceUseCase(d);
    const r = await uc.execute({ reader: reader({ fatalError: 'unmapped_file: header=[A|B]', expectedCount: 5, readCount: 0 }), triggeredBy: 'MANUAL' });
    expect(d.snapshots.writeIfChanged).not.toHaveBeenCalled();
    expect(r.run.completeness).toBe('FAILED');
    expect(d.runs.finish).toHaveBeenCalledWith('run-1', expect.objectContaining({ error: 'unmapped_file: header=[A|B]' }));
  });

  it('leitor que estoura → FAILED com o nome do erro, nunca a mensagem', async () => {
    const d = deps();
    const uc = new SnapshotSourceUseCase(d);
    const boom = new Error('linha com dado sensível');
    boom.name = 'FetchError';
    const r = await uc.execute({ reader: reader(async () => { throw boom; }), triggeredBy: 'SCHEDULER' });
    expect(r.run.completeness).toBe('FAILED');
    const finishArg = d.runs.finish.mock.calls[0][1] as { error: string };
    expect(finishArg.error).toBe('reader_threw:FetchError');
    expect(finishArg.error).not.toContain('sensível');
  });
});
