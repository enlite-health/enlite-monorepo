/**
 * C7 — `country` do serviço contratado é FRONTEIRA, não campo de formulário.
 *
 * O schema de criação aceitava `country` do corpo e o valor chegava ao repositório; o trigger da
 * migration 319 só preenche quando a coluna vem NULL, então o valor explícito VENCE. Um
 * `POST {country:'BR'}` num paciente AR carimbava BR — latente enquanto a RLS de país está
 * desligada, e é exatamente a fronteira para a qual a coluna existe (`cells`/RLS por país).
 *
 * A jurisdição é do PACIENTE. O cliente não a escolhe: `.strict()` recusa a chave (400 "Invalid
 * body", convenção viva do controller para todo erro zod).
 */
import { createContractedServiceSchema, updateContractedServiceSchema } from '../contractedServiceSchemas';

describe('contractedServiceSchemas — country não vem do cliente (C7)', () => {
  it('POST com `country` é RECUSADO (a jurisdição é do paciente, via trigger da 319)', () => {
    const r = createContractedServiceSchema.safeParse({ serviceCode: 'AT', country: 'BR' });
    expect(r.success).toBe(false);
    // `.strict()` reporta chave desconhecida como `unrecognized_keys` (não em fieldErrors).
    if (!r.success) {
      const chaves = r.error.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
      expect(chaves).toContain('country');
    }
  });

  it('POST sem `country` continua válido — e o corpo aceito não tem a chave', () => {
    const r = createContractedServiceSchema.safeParse({ serviceCode: 'AT', weeklyHours: 12 });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.prototype.hasOwnProperty.call(r.data, 'country')).toBe(false);
  });

  it('PATCH nunca teve `country` e segue sem (controle positivo do mesmo `.strict()`)', () => {
    expect(updateContractedServiceSchema.safeParse({ country: 'BR' }).success).toBe(false);
    expect(updateContractedServiceSchema.safeParse({ weeklyHours: 12 }).success).toBe(true);
  });
});
