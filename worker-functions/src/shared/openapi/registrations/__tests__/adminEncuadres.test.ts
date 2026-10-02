/**
 * adminEncuadres.test.ts — o contrato publicado no OpenAPI usa a MESMA lista de
 * etapas que o moveEncuadre valida. Fase 4 (A-contrato, DX-4.17): `targetStage`
 * passa de FUNNEL_STAGES para MOVABLE_FUNNEL_STAGES (+ QUICK_RESPONSE_TEAM) — só o
 * valor esperado muda, a asserção continua a mesma.
 */
import { registry } from '../../registry';
import '../adminEncuadres';
import { MOVABLE_FUNNEL_STAGES } from '@modules/matching/application/FunnelStageEventEmitter';

describe('OpenAPI · PUT /api/admin/encuadres/{id}/move', () => {
  it('targetStage é z.enum(MOVABLE_FUNNEL_STAGES) — não uma cópia inline da lista', () => {
    const route = registry.definitions.find(
      (d) => d.type === 'route' && d.route.method === 'put' && d.route.path === '/api/admin/encuadres/{id}/move',
    );
    expect(route).toBeDefined();
    const body = (route as { route: { request: { body: { content: Record<string, { schema: unknown }> } } } }).route.request.body.content['application/json'].schema as {
      shape: { targetStage: { _def: { values: readonly string[] } } };
    };
    expect(body.shape.targetStage._def.values).toEqual([...MOVABLE_FUNNEL_STAGES]);
  });
});
