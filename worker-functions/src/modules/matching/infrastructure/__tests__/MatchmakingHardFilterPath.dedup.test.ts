/**
 * MatchmakingHardFilterPath — dedup por workerId ANTES do corte topN (spec 089, CA-3).
 * A query devolve 1 linha por área de atuação; a mesma pessoa pode vir 2x.
 */

import { runHardFilterOnlyPath, HardFilterPathDeps } from '../MatchmakingHardFilterPath';
import { JobPosting, WorkerCandidate } from '../MatchmakingTypes';

const CABA = { lat: -34.6037, lng: -58.3816 };
const LA_PLATA = { lat: -34.9215, lng: -57.9545 }; // ~52,6 km
const ROSARIO = { lat: -32.9442, lng: -60.6505 };  // ~280 km

const job = { serviceLat: CABA.lat, serviceLng: CABA.lng } as unknown as JobPosting;

function w(workerId: string, at: { lat: number; lng: number }): WorkerCandidate {
  return {
    workerId,
    firstNameEncrypted: 'enc:Test',
    lastNameEncrypted: 'enc:Sintetico',
    phone: '+0000000000',
    occupation: 'AT',
    workZone: 'Zona',
    workerAddress: 'Dir 1',
    workerLat: at.lat,
    workerLng: at.lng,
    activeCases: [],
    workerStatus: 'REGISTERED',
    alreadyApplied: false,
  } as unknown as WorkerCandidate;
}

function makeDeps(): HardFilterPathDeps {
  return {
    kms: {
      decrypt: jest.fn(async (v: string | null) => (v ? String(v).replace(/^enc:/, '') : null)),
    } as unknown as HardFilterPathDeps['kms'],
    saveMatchResults: jest.fn(async () => undefined),
  };
}

describe('runHardFilterOnlyPath — dedup por workerId', () => {
  it('2 linhas do mesmo worker viram 1 candidato com a MENOR distância', async () => {
    const r = await runHardFilterOnlyPath(
      makeDeps(), 'jp-1', job,
      [w('w-1', LA_PLATA), w('w-1', CABA)],
      50, 20,
    );

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].workerId).toBe('w-1');
    expect(r.candidates[0].distanceKm).toBe(0);
  });

  it('topN=2 com 3 pessoas (uma duplicada) devolve 2 pessoas DISTINTAS, ordenadas por distância', async () => {
    const r = await runHardFilterOnlyPath(
      makeDeps(), 'jp-1', job,
      [w('w-A', CABA), w('w-A', LA_PLATA), w('w-B', LA_PLATA), w('w-C', ROSARIO)],
      300, 2,
    );

    expect(r.candidates.map((c) => c.workerId)).toEqual(['w-A', 'w-B']);
  });
});
