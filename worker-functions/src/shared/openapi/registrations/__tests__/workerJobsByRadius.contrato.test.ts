/**
 * workerJobsByRadius.contrato.test.ts — o item que o Reader DEVOLVE passa no schema que a doc PUBLICA, chave por chave
 * (spec 077 C-37). O item é tipado com a interface do Reader: chave nova no Reader sem chave aqui quebra o tsc do ts-jest;
 * `.strict()` reprova chave que o Reader emite e a doc não declara.
 */
import { WorkerJobByRadiusItem, WorkerJobsByRadiusHomeExtras } from '../workerJobsByRadius';
import { buildOpenApiDocument } from '../../document';
import type { WorkerJobByRadius } from '@modules/matching/infrastructure/WorkerJobsByRadiusReader';

const ITEM: WorkerJobByRadius = {
  id: '22222222-2222-4222-8222-222222222222',
  case_number: 1301,
  vacancy_number: 6309,
  title: 'CASO 1301',
  service: null,
  neighborhood: null,
  city: 'Mar del Plata',
  state: 'Buenos Aires',
  schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  worker_type: ['AT'],
  distance_km: 3,
  already_applied: false,
};

describe('contrato: item de GET /api/workers/me/jobs', () => {
  it('T-F2a-38 o item tipado do Reader passa no schema publicado em modo strict', () => {
    expect(WorkerJobByRadiusItem.strict().safeParse(ITEM).success).toBe(true);
    expect(WorkerJobByRadiusItem.strict().safeParse({ ...ITEM, already_applied: true, schedule: null }).success).toBe(true);
  });

  it('T-F2a-38 a doc declara exatamente as 12 chaves do item e recusa texto de endereço', () => {
    expect(Object.keys(WorkerJobByRadiusItem.shape).sort()).toEqual(
      ['already_applied', 'case_number', 'city', 'distance_km', 'id', 'neighborhood', 'schedule', 'service', 'state', 'title', 'vacancy_number', 'worker_type'].sort(),
    );
    expect(WorkerJobByRadiusItem.strict().safeParse({ ...ITEM, address_formatted: 'x' }).success).toBe(false);
  });

  it('T-F2a-38 o documento gerado publica a rota com radius_km, already_applied, distance_km e os 3 codes de erro', () => {
    const op = JSON.stringify(buildOpenApiDocument().paths['/api/workers/me/jobs']);
    for (const s of ['"radius_km"', '"already_applied"', '"distance_km"', 'INVALID_RADIUS', 'NO_SERVICE_AREA', 'ACCOUNT_INACTIVE']) {
      expect(op).toContain(s);
    }
  });
});

describe('contrato 096: view=home', () => {
  it('CA-4 o documento descreve view, center, applied e missing', () => {
    const op = JSON.stringify(buildOpenApiDocument().paths['/api/workers/me/jobs']);
    for (const s of ['"view"', '"center"', '"applied"', '"missing"', '"schedule"', '"profession"', '"sex"', '"availability"', '"address"']) expect(op).toContain(s);
  });

  it('CA-3 center, applied e missing passam no schema, strict; center é opcional (falta o endereço)', () => {
    const ok = { center: { lat: -37.977, lng: -57.551 }, applied: { schedule: true, profession: false, sex: true }, missing: ['profession'], nearest: [] };
    expect(WorkerJobsByRadiusHomeExtras.strict().safeParse(ok).success).toBe(true);
    const { center: _c, ...semEndereco } = { ...ok, missing: ['address'] };
    expect(WorkerJobsByRadiusHomeExtras.strict().safeParse(semEndereco).success).toBe(true);
    expect(WorkerJobsByRadiusHomeExtras.strict().safeParse({ ...ok, address: 'x' }).success).toBe(false);
    expect(WorkerJobsByRadiusHomeExtras.strict().safeParse({ ...ok, missing: ['clinical_text'] }).success).toBe(false);
    // 096 fallback: `nearest` é lista de itens no MESMO formato de `items` (strict: nada de lat/lng nem endereço)
    const item = { id: '11111111-1111-4111-8111-111111111111', case_number: 1, vacancy_number: 1, title: 't', service: null, neighborhood: null, city: null, state: null, schedule: null, worker_type: [], distance_km: 197.2, already_applied: false };
    expect(WorkerJobsByRadiusHomeExtras.strict().safeParse({ ...ok, nearest: [item] }).success).toBe(true);
    expect(WorkerJobByRadiusItem.strict().safeParse({ ...item, lat: 1 }).success).toBe(false); // `nearest` reusa o schema do item
    expect(WorkerJobsByRadiusHomeExtras.strict().safeParse({ ...ok, nearest: undefined }).success).toBe(false);
    expect(Object.keys(WorkerJobByRadiusItem.shape)).not.toEqual(expect.arrayContaining(['lat', 'lng']));
  });
});
