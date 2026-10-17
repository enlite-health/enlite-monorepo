import {
  vacancyEffectiveColumnsSql,
  vacancyEffectivePaymentDaySql,
  vacancyEffectiveRequiredExperienceSql,
  vacancyEffectiveRequiredProfessionsSql,
  vacancyEffectiveRequiredSexSql,
  vacancyEffectiveWorkScheduleSql,
} from '../vacancyEffectiveFieldsSql';

describe('vacancyEffectiveFieldsSql — 5 campos de recrutamento (057/D523)', () => {
  const simples = (f: string) => `CASE WHEN jp.contracted_service_id IS NOT NULL THEN e.${f} ELSE jp.${f} END`;

  it('required_sex, required_experience, work_schedule e payment_day: CASE serviço/vaga, sem COALESCE', () => {
    expect(vacancyEffectiveRequiredSexSql('jp', 'e')).toBe(simples('required_sex'));
    expect(vacancyEffectiveRequiredExperienceSql('jp', 'e')).toBe(simples('required_experience'));
    expect(vacancyEffectiveWorkScheduleSql('jp', 'e')).toBe(simples('work_schedule'));
    expect(vacancyEffectivePaymentDaySql('jp', 'e')).toBe(simples('payment_day'));
  });

  it('required_professions: serviço com NULL vira {} (nunca NULL para o leitor); vaga manual lê a própria', () => {
    expect(vacancyEffectiveRequiredProfessionsSql('jp', 'e')).toBe(
      "CASE WHEN jp.contracted_service_id IS NOT NULL THEN COALESCE(e.required_professions, '{}'::text[]) ELSE jp.required_professions END",
    );
  });

  it('os defaults de alias são jp / pcs_eff', () => {
    expect(vacancyEffectiveRequiredSexSql()).toContain('pcs_eff.required_sex');
  });

  it('vacancyEffectiveColumnsSql troca cada uma das 5 e mantém o nome de saída (1x cada)', () => {
    const cols = vacancyEffectiveColumnsSql('jp', 'e');
    for (const f of ['required_sex', 'required_professions', 'required_experience', 'work_schedule', 'payment_day']) {
      expect(cols.split(`AS ${f}`).length - 1).toBe(1);
      expect(cols).not.toContain(`jp.${f}, `);
    }
    expect(cols).toContain(`${simples('required_sex')} AS required_sex`);
  });
});
