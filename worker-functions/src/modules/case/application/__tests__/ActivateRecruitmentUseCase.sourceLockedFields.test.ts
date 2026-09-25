/**
 * ActivateRecruitmentUseCase.sourceLockedFields.test.ts — "paridade" (fase 1,
 * change `completar-vacante-em-rascunho`, `openspec/changes/completar-vacante-em-rascunho/fase-1.md`).
 *
 * Ao contrário de `ActivateRecruitmentUseCase.test.ts` (que mocka `@modules/matching`
 * inteiro para isolar a orquestração), este arquivo usa `buildInsertParams`/
 * `pickSourceLockedFields`/`SOURCE_LOCKED_FIELDS` REAIS — é a prova de que o
 * INSERT do foguete deriva as 8 colunas que vêm do paciente/serviço (F3) SÓ da
 * constante nomeada, sem duplicar a lista em outro lugar.
 *
 * Roda dentro de `src/modules/case` de propósito (`npx jest src/modules/case
 * -t "paridade"`, fase-1.md "Termina quando" #1) — mesmo escopo do teste do
 * use case que consome esta constante.
 *
 * Sabotagem (fase-1.md #2): fazer `pickSourceLockedFields`/`buildInsertParams`
 * lerem um campo novo (ex.: `daily_obs`) sem acrescentá-lo a
 * `SOURCE_LOCKED_FIELDS` derruba o teste "paridade: pickSourceLockedFields..."
 * abaixo (o Object.keys diverge da constante). Restaurar de `cp`, nunca `git
 * checkout --` (memória `sabotagem-restaura-de-cp-nunca-git-checkout`).
 */
import {
  SOURCE_LOCKED_FIELDS,
  pickSourceLockedFields,
  buildInsertParams,
  buildInsertQuery,
  type VacancyInsertParams,
  type SourceLockedField,
} from '@modules/matching';

/**
 * Espelha o que `ActivateRecruitmentUseCase.runInTransaction` monta de
 * verdade (`ActivateRecruitmentUseCase.ts`, chamada a `buildInsertParams`):
 * os 8 campos do serviço/paciente (F3) com valor; os demais — deixados para
 * o recrutamento — null/undefined, como o foguete sempre manda.
 */
function fogueteArgs(overrides: Partial<VacancyInsertParams> = {}): VacancyInsertParams {
  return {
    vacancyNumber: 500,
    case_number: 1000,
    computedTitle: 'CASO EN1000-500',
    patient_id: 'patient-1',
    patient_address_id: 'addr-1',
    contracted_service_id: 'service-1',
    age_range_min: 20,
    age_range_max: 29,
    schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    providers_needed: 2,
    required_professions: null,
    required_sex: null,
    worker_profile_sought: null,
    required_experience: null,
    worker_attributes: null,
    work_schedule: null,
    salary_text: null,
    payment_day: null,
    daily_obs: null,
    status: undefined,
    published_at: null,
    closes_at: null,
    is_test: false,
    ...overrides,
  };
}

describe('paridade — SOURCE_LOCKED_FIELDS × buildInsertParams (fase 1, F3)', () => {
  it('paridade: SOURCE_LOCKED_FIELDS são exatamente os 8 campos que o foguete preenche do paciente/serviço (F3)', () => {
    expect([...SOURCE_LOCKED_FIELDS].sort()).toEqual(
      [
        'age_range_max',
        'age_range_min',
        'case_number',
        'contracted_service_id',
        'patient_address_id',
        'patient_id',
        'providers_needed',
        'schedule',
      ].sort(),
    );
  });

  it('paridade: pickSourceLockedFields(p) devolve exatamente as chaves de SOURCE_LOCKED_FIELDS — nem a mais, nem a menos', () => {
    const locked = pickSourceLockedFields(fogueteArgs());
    expect(Object.keys(locked).sort()).toEqual([...SOURCE_LOCKED_FIELDS].sort());
  });

  it('paridade: buildInsertParams deriva CADA campo travado de pickSourceLockedFields(p) — variar só ele muda só a posição dele no INSERT', () => {
    const base = fogueteArgs();
    const baseParams = buildInsertParams(base);

    const overridesPerField: Record<SourceLockedField, unknown> = {
      case_number: 4242,
      patient_id: 'patient-DIFERENTE',
      patient_address_id: 'addr-DIFERENTE',
      contracted_service_id: 'service-DIFERENTE',
      age_range_min: 99,
      age_range_max: 100,
      schedule: [{ dayOfWeek: 5, startTime: '10:00', endTime: '14:00' }],
      providers_needed: 7,
    };

    for (const field of SOURCE_LOCKED_FIELDS) {
      const variant = buildInsertParams({ ...base, [field]: overridesPerField[field] });
      const diffIndexes = baseParams
        .map((_, i) => i)
        .filter((i) => JSON.stringify(baseParams[i]) !== JSON.stringify(variant[i]));
      // Mudar SÓ este campo travado muda exatamente 1 posição do array de
      // params — a dele. Prova que o valor flui de `p[field]` (via
      // `pickSourceLockedFields`), não de um literal duplicado em outro lugar
      // do array (o que faria 0 ou >1 posições mudarem).
      expect({ field, diffIndexes }).toEqual({ field, diffIndexes: [diffIndexes[0]] });
      expect(diffIndexes).toHaveLength(1);
    }
  });

  it('paridade: buildInsertParams não muda de tamanho — mesmo número de colunas do INSERT de sempre (baseline Fase 0)', () => {
    const params = buildInsertParams(fogueteArgs());
    const placeholders = (buildInsertQuery().match(/\$\d+/g) ?? []).map((s) => parseInt(s.slice(1), 10));
    expect(params).toHaveLength(Math.max(...placeholders));
  });

  it('campo NÃO travado (ex.: required_professions, deixado para o recrutamento por F3) não sai de pickSourceLockedFields', () => {
    const locked = pickSourceLockedFields(fogueteArgs({ required_professions: ['AT'] }));
    expect(locked).not.toHaveProperty('required_professions');
  });
});
