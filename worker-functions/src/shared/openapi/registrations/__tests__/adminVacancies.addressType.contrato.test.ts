/**
 * adminVacancies.addressType.contrato.test.ts — spec 019 (B4/B7):
 * `resolve-address-review` era o único ponto aceitando `address_type` como STRING LIVRE, sem
 * validação de lista (o mais arriscado dos 11 escritores). Depois da entrega, `createAddress`
 * (endereço inline) não aceita mais `address_type` nenhum — nasce NULL, valor só via PATCH.
 */
import { registry } from '../../registry';
import '../adminVacancies';

describe('OpenAPI · POST /api/admin/vacancies/{id}/resolve-address-review', () => {
  it('createAddress não tem address_type no contrato publicado (spec 019, B4)', () => {
    const route = registry.definitions.find(
      (d) => d.type === 'route' && d.route.method === 'post' && d.route.path === '/api/admin/vacancies/{id}/resolve-address-review',
    );
    expect(route).toBeDefined();
    const body = (route as { route: { request: { body: { content: Record<string, { schema: unknown }> } } } })
      .route.request.body.content['application/json'].schema as { shape: { createAddress: { unwrap(): { shape: Record<string, unknown> } } } };
    const createAddressShape = body.shape.createAddress.unwrap().shape;
    expect(createAddressShape).not.toHaveProperty('address_type');
    expect(createAddressShape).toHaveProperty('address_formatted');
  });
});
