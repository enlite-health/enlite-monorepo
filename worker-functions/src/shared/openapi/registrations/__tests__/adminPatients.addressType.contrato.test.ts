/**
 * adminPatients.addressType.contrato.test.ts — spec 019 (D310 item c, B4/B7):
 *
 *   - `POST /api/admin/patients/{patientId}/addresses` NÃO aceita `address_type` (removido da
 *     criação — nasce NULL, valor só via PATCH).
 *   - `PATCH /api/admin/patients/{patientId}/addresses/{addressId}` usa a MESMA instância de
 *     `updatePatientAddressSchema` que valida a requisição em `AdminPatientAddressesController`
 *     (K8 — fonte única, nunca uma segunda cópia que possa divergir do `.strict()`/`.refine()`).
 *   - a lista fechada publicada é a MESMA `PATIENT_ADDRESS_TYPES` do controller (inclui `escuela`,
 *     decisão B7).
 */
import { registry } from '../../registry';
import '../adminPatients';
import { updatePatientAddressSchema, PATIENT_ADDRESS_TYPES } from '@modules/case';

function bodySchemaOf(method: string, path: string): { shape: Record<string, unknown> } {
  const route = registry.definitions.find(
    (d) => d.type === 'route' && d.route.method === method && d.route.path === path,
  );
  expect(route).toBeDefined();
  const schema = (route as { route: { request: { body: { content: Record<string, { schema: unknown }> } } } })
    .route.request.body.content['application/json'].schema;
  return schema as { shape: Record<string, unknown> };
}

describe('OpenAPI · POST /api/admin/patients/{patientId}/addresses', () => {
  it('address_type NÃO está no schema publicado da criação (spec 019, B4)', () => {
    const body = bodySchemaOf('post', '/api/admin/patients/{patientId}/addresses');
    expect(body.shape).not.toHaveProperty('address_type');
    expect(body.shape).not.toHaveProperty('address_type_other');
    expect(body.shape).toHaveProperty('is_default');
  });
});

describe('OpenAPI · PATCH /api/admin/patients/{patientId}/addresses/{addressId}', () => {
  it('o body publicado é a MESMA instância de updatePatientAddressSchema — sem segunda cópia (K8)', () => {
    const route = registry.definitions.find(
      (d) => d.type === 'route' && d.route.method === 'patch' && d.route.path === '/api/admin/patients/{patientId}/addresses/{addressId}',
    );
    expect(route).toBeDefined();
    const schema = (route as { route: { request: { body: { content: Record<string, { schema: unknown }> } } } })
      .route.request.body.content['application/json'].schema;
    expect(schema).toBe(updatePatientAddressSchema);
  });

  it('a lista fechada publicada inclui "escuela" (decisão B7) e é a MESMA PATIENT_ADDRESS_TYPES do controller', () => {
    // address_type: z.enum(...).nullable().optional() → ZodOptional<ZodNullable<ZodEnum>>.
    const inner = (updatePatientAddressSchema as unknown as {
      innerType(): { shape: { address_type: { _def: { innerType: { _def: { innerType: { _def: { values: readonly string[] } } } } } } } };
    }).innerType();
    const values = inner.shape.address_type._def.innerType._def.innerType._def.values;
    expect(values).toEqual([...PATIENT_ADDRESS_TYPES]);
    expect(values).toContain('escuela');
  });

  it('is_default publicado só aceita `true` — `false` é 400 (override 12/09: desmarcar só acontece marcando OUTRO principal)', () => {
    // is_default: z.literal(true).optional() → ZodOptional<ZodLiteral<true>>.
    const inner = (updatePatientAddressSchema as unknown as {
      innerType(): { shape: { is_default: { _def: { innerType: { _def: { value: unknown } } } } } };
    }).innerType();
    expect(inner.shape.is_default._def.innerType._def.value).toBe(true);
    expect(updatePatientAddressSchema.safeParse({ is_default: true }).success).toBe(true);
    expect(updatePatientAddressSchema.safeParse({ is_default: false }).success).toBe(false);
  });
});
