jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '@shared/logging';
import type { RawRoute } from '../../domain/transitRoute';
import type { PatientItineraryItem, WorkerZoneLookup } from '../ports/WorkerTransitPorts';
import { GetWorkerTransitToPatientUseCase } from '../GetWorkerTransitToPatientUseCase';

// Dados sintéticos: nenhuma coordenada, endereço ou pessoa real. Dublês das 3 portas; nada de banco nem Google.
const WID = '11111111-1111-4111-8111-111111111111';
const REF = '9f103f86-26dc-53ac-8c3a-92951d0e0537';
const ZONA = { label: 'QA077 zona sintetica, Mar del Plata', point: { lat: -38.0023, lng: -57.5575 } };
const PONTO = { lat: -38.00016, lng: -57.5559 };
const RAW: RawRoute[] = JSON.parse(readFileSync(resolve(__dirname, '../../domain/__tests__/fixtures/routes-api-caba.json'), 'utf8')).routes;
const item = (over: Partial<PatientItineraryItem> = {}): PatientItineraryItem => ({ hasAddress: true, country: 'AR', point: PONTO, ...over });

function build(opts: { worker?: WorkerZoneLookup; items?: PatientItineraryItem[] } = {}) {
  const findByAuthUid = jest.fn(async (): Promise<WorkerZoneLookup> => opts.worker ?? { found: true, workerId: WID, disabled: false, zone: ZONA });
  const itemsOf = jest.fn(async (): Promise<PatientItineraryItem[]> => opts.items ?? [item()]);
  const transit = jest.fn(async (): Promise<{ called: boolean; routes: RawRoute[] }> => ({ called: true, routes: RAW }));
  const uc = new GetWorkerTransitToPatientUseCase({ findByAuthUid }, { itemsOf }, { transitCall: transit });
  return { uc, findByAuthUid, itinerary: itemsOf, transit };
}

const logs = () => (logger.info as jest.Mock).mock.calls.map((c) => c[0]);

describe('GetWorkerTransitToPatientUseCase', () => {
  beforeEach(() => jest.clearAllMocks());

  it('T-F4-04 sem zona → NO_SERVICE_AREA antes de ler o itinerário e 0 chamadas ao Google', async () => {
    const { uc, itinerary, transit } = build({ worker: { found: true, workerId: WID, disabled: false, zone: null } });
    expect(await uc.execute('uid-token', REF, '2026-11-02')).toEqual({ ok: false, code: 'NO_SERVICE_AREA' });
    expect(itinerary).not.toHaveBeenCalled();
    expect(transit).toHaveBeenCalledTimes(0);
    expect(logs()).toEqual([{ msg: 'transit.me', outcome: 'NO_SERVICE_AREA', google_calls: 0 }]);
  });

  it('T-F4-04 paciente só em hoje+9 (item sem endereço) → ADDRESS_NOT_AVAILABLE e 0 chamadas', async () => {
    const { uc, transit } = build({ items: [item({ hasAddress: false })] });
    expect(await uc.execute('uid-token', REF, '2026-11-02')).toEqual({ ok: false, code: 'ADDRESS_NOT_AVAILABLE' });
    expect(transit).toHaveBeenCalledTimes(0);
  });

  it('T-F4-04 patient_ref que não está no itinerário dela → ADDRESS_NOT_AVAILABLE e 0 chamadas', async () => {
    const { uc, transit } = build({ items: [] });
    expect(await uc.execute('uid-token', '00000000-0000-5000-8000-000000000000', '2026-11-02')).toEqual({ ok: false, code: 'ADDRESS_NOT_AVAILABLE' });
    expect(transit).toHaveBeenCalledTimes(0);
  });

  it('T-F4-04 prestador inexistente ou DISABLED → ACCOUNT_INACTIVE e 0 chamadas', async () => {
    for (const worker of [{ found: false } as const, { found: true, workerId: WID, disabled: true, zone: ZONA } as const]) {
      const { uc, transit, itinerary } = build({ worker });
      expect(await uc.execute('uid-token', REF, '2026-11-02')).toEqual({ ok: false, code: 'ACCOUNT_INACTIVE' });
      expect(transit).toHaveBeenCalledTimes(0);
      expect(itinerary).not.toHaveBeenCalled();
    }
  });

  it('T-F4-04 ok → 1 chamada com a coordenada da ZONA como origem (nunca a do paciente) e o ponto do item como destino', async () => {
    const { uc, transit, itinerary, findByAuthUid } = build();
    const out = await uc.execute('uid-token', REF, '2026-11-02');
    expect(transit).toHaveBeenCalledTimes(1);
    expect(transit).toHaveBeenCalledWith(ZONA.point, PONTO);
    expect(findByAuthUid).toHaveBeenCalledWith('uid-token');
    expect(itinerary).toHaveBeenCalledWith(WID, REF, '2026-11-02');
    expect(out).toMatchObject({ ok: true, origin_label: ZONA.label });
    expect(logs()).toEqual([{ msg: 'transit.me', outcome: 'ok', google_calls: 1 }]);
  });

  it('T-F4-04 a resposta leva só modo, minutos e pernas de transporte (linha, de, até): sem polilinha, cor, metro ou coordenada', async () => {
    const { uc } = build();
    const out = await uc.execute('uid-token', REF, '2026-11-02');
    if (!out.ok) throw new Error('esperava ok');
    expect(out.routes.length).toBeGreaterThan(0);
    for (const r of out.routes) {
      expect(Object.keys(r).sort()).toEqual(['duration_min', 'mode', 'steps']);
      for (const s of r.steps) expect(Object.keys(s).sort()).toEqual(['from', 'line', 'to']);
    }
    const json = JSON.stringify(out);
    for (const proibido of ['paths', 'encodedPolyline', 'color', 'meters', '-38.0023', String(PONTO.lat)]) expect(json).not.toContain(proibido);
  });

  it('T-F4-04 item sem ponto → 200 sem rotas e 0 chamadas; Google sem rota → 200 sem rotas', async () => {
    const semPonto = build({ items: [item({ point: null })] });
    expect(await semPonto.uc.execute('uid-token', REF, '2026-11-02')).toEqual({ ok: true, origin_label: ZONA.label, routes: [] });
    expect(semPonto.transit).toHaveBeenCalledTimes(0);
    const semRota = build();
    semRota.transit.mockResolvedValueOnce({ called: true, routes: [] });
    expect(await semRota.uc.execute('uid-token', REF, '2026-11-02')).toEqual({ ok: true, origin_label: ZONA.label, routes: [] });
  });

  it('T-F4-04 item de paciente BR (lex B3, LGPD art. 33) → ADDRESS_NOT_AVAILABLE e 0 chamadas ao Google', async () => {
    const { uc, transit } = build({ items: [item({ country: 'BR' })] });
    expect(await uc.execute('uid-token', REF, '2026-11-02')).toEqual({ ok: false, code: 'ADDRESS_NOT_AVAILABLE' });
    expect(transit).toHaveBeenCalledTimes(0);
    expect(logs()).toEqual([{ msg: 'transit.me', outcome: 'ADDRESS_NOT_AVAILABLE', google_calls: 0 }]);
  });

  it('T-F4-04 o log conta a requisição que SAIU: o adapter sem chave (called false) loga google_calls 0, não 1', async () => {
    const { uc, transit } = build();
    transit.mockResolvedValueOnce({ called: false, routes: [] });
    expect(await uc.execute('uid-token', REF, '2026-11-02')).toEqual({ ok: true, origin_label: ZONA.label, routes: [] });
    expect(transit).toHaveBeenCalledTimes(1);
    expect(logs()).toEqual([{ msg: 'transit.me', outcome: 'sem_ruta', google_calls: 0 }]);
  });

  it('T-F4-04 o log não leva uid, ref, endereço nem coordenada', async () => {
    const { uc } = build();
    await uc.execute('uid-token', REF, '2026-11-02');
    const linha = JSON.stringify(logs());
    for (const proibido of ['uid-token', REF, 'zona sintetica', '-38']) expect(linha).not.toContain(proibido);
  });
});
