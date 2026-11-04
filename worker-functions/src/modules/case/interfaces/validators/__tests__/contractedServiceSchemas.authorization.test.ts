import { createContractedServiceSchema, updateContractedServiceSchema } from '../contractedServiceSchemas';

// Spec 056: as horas autorizadas têm dono próprio (contracted_service_authorization); a chave saiu do corpo do serviço.
describe('contractedServiceSchemas — authorizedHours saiu da escrita', () => {
  it('create com authorizedHours → falha (.strict → 400)', () => {
    expect(createContractedServiceSchema.safeParse({ serviceCode: 'AT', authorizedHours: 20 }).success).toBe(false);
  });

  it('update com authorizedHours → falha (.strict → 400)', () => {
    expect(updateContractedServiceSchema.safeParse({ authorizedHours: 20 }).success).toBe(false);
  });

  it('sem authorizedHours os mesmos corpos passam', () => {
    expect(createContractedServiceSchema.safeParse({ serviceCode: 'AT' }).success).toBe(true);
    expect(updateContractedServiceSchema.safeParse({ providersNeeded: 2 }).success).toBe(true);
  });
});
