/**
 * Spec 027 Fase 3 (T033; lex S.1, W.1, T.7): os 7 campos de recrutamento do serviço contratado — fechados, com enum e com teto.
 * Sabotagem: trocar `z.enum(REQUIRED_SEX_VALUES)` por `z.string()` deixa "required_sex fora da lista" vermelho.
 */
import {
  createContractedServiceSchema,
  updateContractedServiceSchema,
  REQUIRED_EXPERIENCE_MAX,
  WORKER_ATTRIBUTES_MAX,
  DAILY_OBS_MAX,
  PAYMENT_DAY_MAX,
} from '../contractedServiceSchemas';

const base = { serviceCode: 'AT' as const };
const schemas = [
  ['create', (b: object) => createContractedServiceSchema.safeParse({ ...base, ...b })],
  ['update', (b: object) => updateContractedServiceSchema.safeParse(b)],
] as const;

describe.each(schemas)('contractedServiceSchemas (%s) — campos de recrutamento', (_name, parse) => {
  it.each(['X', 'Mujer', 'MALE', 'm', ''])('requiredSex fora da lista (%p) → recusa (S.1)', (v) => {
    expect(parse({ requiredSex: v }).success).toBe(false);
  });

  it.each(['M', 'F', 'BOTH', null])('requiredSex válido (%p) → ok', (v) => {
    expect(parse({ requiredSex: v }).success).toBe(true);
  });

  it('workSchedule fora do vocabulário → recusa; vocabulário do parser → ok (W.1)', () => {
    expect(parse({ workSchedule: 'turno libre' }).success).toBe(false);
    for (const v of ['full-time', 'part-time', 'flexible']) expect(parse({ workSchedule: v }).success).toBe(true);
  });

  it.each([
    ['requiredExperience', REQUIRED_EXPERIENCE_MAX],
    ['workerAttributes', WORKER_ATTRIBUTES_MAX],
    ['paymentDay', PAYMENT_DAY_MAX],
    ['dailyObs', DAILY_OBS_MAX],
  ])('%s: max+1 caracteres → recusa; max → ok (T.7)', (field, max) => {
    expect(parse({ [field]: 'a'.repeat(max + 1) }).success).toBe(false);
    expect(parse({ [field]: 'a'.repeat(max) }).success).toBe(true);
  });

  it('requiredProfessions: lista de textos curtos ok; item vazio, item longo ou lista grande → recusa', () => {
    expect(parse({ requiredProfessions: ['AT', 'CAREGIVER'] }).success).toBe(true);
    expect(parse({ requiredProfessions: [''] }).success).toBe(false);
    expect(parse({ requiredProfessions: ['a'.repeat(81)] }).success).toBe(false);
    expect(parse({ requiredProfessions: Array.from({ length: 21 }, () => 'AT') }).success).toBe(false);
  });

  it('continua .strict(): campo desconhecido e coluna de "motivo" do sexo (S.4) → recusa', () => {
    expect(parse({ campoQueNaoExiste: 1 }).success).toBe(false);
    expect(parse({ requiredSex: 'F', requiredSexReason: 'x' }).success).toBe(false);
  });
});
