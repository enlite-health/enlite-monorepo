/**
 * workerJobsByRadius.contrato.test.ts — o item que o Reader DEVOLVE passa no schema que a doc PUBLICA, chave por chave
 * (spec 077 C-37). O item é tipado com a interface do Reader: chave nova no Reader sem chave aqui quebra o tsc do ts-jest;
 * `.strict()` reprova chave que o Reader emite e a doc não declara.
 */
import { WorkerJobByRadiusItem } from '../workerJobsByRadius';
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
