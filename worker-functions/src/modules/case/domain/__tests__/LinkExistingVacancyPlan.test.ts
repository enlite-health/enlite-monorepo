import {
  linkExistingVacancyPlan,
  VACANCY_SERVICE_OWNED_COLUMNS,
  type ServiceLinkTarget,
  type VacancyLinkSource,
  type FeedableRecruitmentField,
} from '../LinkExistingVacancyPlan';

const emptyVacancy = (o: Partial<VacancyLinkSource> = {}): VacancyLinkSource => ({
  required_professions: null,
  required_experience: null,
  work_schedule: null,
  payment_day: null,
  required_sex: null,
  providers_needed: null,
  age_range_min: null,
  age_range_max: null,
  schedule: null,
  patient_address_id: null,
  ...o,
});
const emptyService = (o: Partial<ServiceLinkTarget> = {}): ServiceLinkTarget => ({
  required_professions: null,
  required_experience: null,
  work_schedule: null,
  payment_day: null,
  required_sex: null,
  providers_needed: null,
  provider_age_band: null,
  address_id: null,
  hasSchedule: false,
  ...o,
});
const yes = () => true;

const TEXT_FIELDS = ['required_experience', 'work_schedule', 'payment_day', 'required_sex'] as const;
const V: Record<string, string> = { required_experience: '5', work_schedule: 'full-time', payment_day: '10', required_sex: 'F' };
const S: Record<string, string> = { required_experience: '9', work_schedule: 'part-time', payment_day: '20', required_sex: 'M' };

describe('linkExistingVacancyPlan', () => {
  describe('serviço preenchido vence (×5)', () => {
    it.each(TEXT_FIELDS)('%s: vale o serviço, sem feed, origin SERVICE', (f) => {
      const r = linkExistingVacancyPlan(emptyVacancy({ [f]: V[f] }), emptyService({ [f]: S[f] }), yes);
      expect(r.serviceFeed[f]).toBeUndefined();
      expect(r.rows.find((x) => x.field === f)).toEqual({ field: f, vacancyValue: V[f], effectiveValue: S[f], origin: 'SERVICE' });
      expect(r.vacancyClear.map((c) => c.column)).toContain(f);
    });
    it('required_professions: vale o serviço', () => {
      const r = linkExistingVacancyPlan(
        emptyVacancy({ required_professions: ['AT'] }),
        emptyService({ required_professions: ['TO'] }),
        yes,
      );
      expect(r.serviceFeed.required_professions).toBeUndefined();
      expect(r.rows.find((x) => x.field === 'required_professions')?.origin).toBe('SERVICE');
    });
  });

  describe('serviço vazio recebe da vaga (×5)', () => {
    it.each(TEXT_FIELDS)('%s: entra no serviceFeed (VACANCY)', (f) => {
      const r = linkExistingVacancyPlan(emptyVacancy({ [f]: V[f] }), emptyService(), yes);
      expect(r.serviceFeed[f]).toBe(V[f]);
      expect(r.warnings).toEqual([]);
    });
    it('required_professions: entra no serviceFeed', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ required_professions: ['AT'] }), emptyService(), yes);
      expect(r.serviceFeed.required_professions).toEqual(['AT']);
    });
  });

  it('accepts=false: aviso VALUE_OUTSIDE_SERVICE_DOMAIN, sem feed, origin NONE, effective null', () => {
    const calls: Array<[FeedableRecruitmentField, unknown]> = [];
    const r = linkExistingVacancyPlan(
      emptyVacancy({ required_sex: 'Femenino', required_professions: ['AT'] }),
      emptyService(),
      (f, v) => {
        calls.push([f, v]);
        return false;
      },
    );
    expect(r.serviceFeed).toEqual({});
    expect(r.warnings).toEqual([
      { field: 'required_sex', code: 'VALUE_OUTSIDE_SERVICE_DOMAIN' },
      { field: 'required_professions', code: 'VALUE_OUTSIDE_SERVICE_DOMAIN' },
    ]);
    expect(r.rows.find((x) => x.field === 'required_sex')).toEqual({
      field: 'required_sex', vacancyValue: 'Femenino', effectiveValue: null, origin: 'NONE',
    });
    expect(r.effective.recruitmentFields.requiredSex).toBeNull();
    expect(calls).toContainEqual(['required_sex', 'Femenino']);
  });

  it('accepts não é consultado quando o serviço já está preenchido', () => {
    const accepts = jest.fn().mockReturnValue(true);
    linkExistingVacancyPlan(emptyVacancy({ payment_day: '10' }), emptyService({ payment_day: '20' }), accepts);
    expect(accepts).not.toHaveBeenCalled();
  });

  it('required_professions [] = vazio na vaga (nada alimenta, nada em vacancyClear)', () => {
    const r = linkExistingVacancyPlan(emptyVacancy({ required_professions: [] }), emptyService(), yes);
    expect(r.serviceFeed.required_professions).toBeUndefined();
    expect(r.vacancyClear.map((c) => c.column)).not.toContain('required_professions');
  });
  it('required_professions [] = vazio no serviço (a vaga alimenta)', () => {
    const r = linkExistingVacancyPlan(
      emptyVacancy({ required_professions: ['AT'] }),
      emptyService({ required_professions: [] }),
      yes,
    );
    expect(r.serviceFeed.required_professions).toEqual(['AT']);
  });

  it('string só com espaços = vazio na vaga (nunca alimenta string vazia)', () => {
    const r = linkExistingVacancyPlan(emptyVacancy({ payment_day: '   ' }), emptyService(), yes);
    expect(r.serviceFeed.payment_day).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(r.vacancyClear).toEqual([]);
  });
  it('string só com espaços = vazio no serviço (a vaga alimenta)', () => {
    const r = linkExistingVacancyPlan(emptyVacancy({ payment_day: '10' }), emptyService({ payment_day: '  ' }), yes);
    expect(r.serviceFeed.payment_day).toBe('10');
  });

  describe('providers_needed', () => {
    it("'3' → 3", () => {
      expect(linkExistingVacancyPlan(emptyVacancy({ providers_needed: '3' }), emptyService(), yes).serviceFeed.providers_needed).toBe(3);
    });
    it("' 2 ' → 2", () => {
      expect(linkExistingVacancyPlan(emptyVacancy({ providers_needed: ' 2 ' }), emptyService(), yes).serviceFeed.providers_needed).toBe(2);
    });
    it.each(['0', 'dos', '2.5', '-1', '99999999999'])("'%s' → aviso, sem feed", (txt) => {
      const r = linkExistingVacancyPlan(emptyVacancy({ providers_needed: txt }), emptyService(), yes);
      expect(r.serviceFeed.providers_needed).toBeUndefined();
      expect(r.warnings).toEqual([{ field: 'providers_needed', code: 'PROVIDERS_NEEDED_NOT_INTEGER' }]);
    });
    it('serviço preenchido vence (sem aviso mesmo com texto inválido)', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ providers_needed: 'dos' }), emptyService({ providers_needed: 4 }), yes);
      expect(r.serviceFeed.providers_needed).toBeUndefined();
      expect(r.warnings).toEqual([]);
      expect(r.rows.find((x) => x.field === 'providers_needed')?.origin).toBe('SERVICE');
    });
    it('vaga vazia: nada, sem aviso', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ providers_needed: ' ' }), emptyService(), yes);
      expect(r.serviceFeed).toEqual({});
      expect(r.warnings).toEqual([]);
    });
  });

  describe('age_range', () => {
    it('(20,29) → AGE_20_30 no feed', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ age_range_min: 20, age_range_max: 29 }), emptyService(), yes);
      expect(r.serviceFeed.provider_age_band).toBe('AGE_20_30');
      expect(r.rows.find((x) => x.field === 'age_range')).toBeUndefined();
    });
    it('(20,30) sem faixa exata → aviso AGE_RANGE_NO_EXACT_BAND', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ age_range_min: 20, age_range_max: 30 }), emptyService(), yes);
      expect(r.serviceFeed.provider_age_band).toBeUndefined();
      expect(r.warnings).toEqual([{ field: 'age_range', code: 'AGE_RANGE_NO_EXACT_BAND' }]);
    });
    it('(null,null) → nada, sem aviso, sem row', () => {
      const r = linkExistingVacancyPlan(emptyVacancy(), emptyService(), yes);
      expect(r.serviceFeed).toEqual({});
      expect(r.warnings).toEqual([]);
      expect(r.rows).toEqual([]);
    });
    it('serviço com banda vence', () => {
      const r = linkExistingVacancyPlan(
        emptyVacancy({ age_range_min: 20, age_range_max: 29 }),
        emptyService({ provider_age_band: 'AGE_45_PLUS' }),
        yes,
      );
      expect(r.serviceFeed.provider_age_band).toBeUndefined();
      expect(r.rows.find((x) => x.field === 'age_range')).toEqual({
        field: 'age_range', vacancyValue: { min: 20, max: 29 }, effectiveValue: { min: 45, max: null }, origin: 'SERVICE',
      });
    });
    it('esvazia os dois (min e max) quando a vaga tem valor', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ age_range_min: 20, age_range_max: 29 }), emptyService(), yes);
      expect(r.vacancyClear).toEqual([
        { column: 'age_range_min', before: 20 },
        { column: 'age_range_max', before: 29 },
      ]);
    });
  });

  describe('schedule', () => {
    it('nunca alimenta; row NONE sem faixas no serviço; esvazia', () => {
      const sched = [{ day: 1 }];
      const r = linkExistingVacancyPlan(emptyVacancy({ schedule: sched }), emptyService({ hasSchedule: false }), yes);
      expect(Object.keys(r.serviceFeed)).toEqual([]);
      expect(r.rows).toEqual([{ field: 'schedule', vacancyValue: sched, effectiveValue: null, origin: 'NONE' }]);
      expect(r.vacancyClear).toEqual([{ column: 'schedule', before: sched }]);
    });
    it('row SERVICE quando o serviço tem faixas', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ schedule: [{ day: 1 }] }), emptyService({ hasSchedule: true }), yes);
      expect(r.rows[0].origin).toBe('SERVICE');
      expect(r.serviceFeed).toEqual({});
    });
    it('vaga sem schedule: nada', () => {
      const r = linkExistingVacancyPlan(emptyVacancy(), emptyService({ hasSchedule: true }), yes);
      expect(r.rows).toEqual([]);
      expect(r.vacancyClear).toEqual([]);
    });
  });

  describe('endereço', () => {
    it('igual: nada', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ patient_address_id: 'a1' }), emptyService({ address_id: 'a1' }), yes);
      expect(r.addressBlocked).toBe(false);
      expect(r.serviceFeed.address_id).toBeUndefined();
      expect(r.rows).toEqual([]);
    });
    it('diferente: addressBlocked', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ patient_address_id: 'a1' }), emptyService({ address_id: 'a2' }), yes);
      expect(r.addressBlocked).toBe(true);
      expect(r.serviceFeed.address_id).toBeUndefined();
    });
    it('serviço sem endereço: alimenta', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ patient_address_id: 'a1' }), emptyService(), yes);
      expect(r.serviceFeed.address_id).toBe('a1');
      expect(r.rows).toEqual([]);
      expect(r.effective.hasAddress).toBe(true);
    });
    it('vaga sem endereço e serviço com: sem linha (a vaga mantém o seu, null)', () => {
      const r = linkExistingVacancyPlan(emptyVacancy(), emptyService({ address_id: 'a2' }), yes);
      expect(r.rows).toEqual([]);
      expect(r.effective.hasAddress).toBe(true);
    });
    it('nenhum dos dois: hasAddress false', () => {
      expect(linkExistingVacancyPlan(emptyVacancy(), emptyService(), yes).effective.hasAddress).toBe(false);
    });
    it('patient_address_id nunca está em vacancyClear', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ patient_address_id: 'a1' }), emptyService(), yes);
      expect(r.vacancyClear.map((c) => c.column as string)).not.toContain('patient_address_id');
    });
  });

  describe('lista fechada e vacancyClear', () => {
    it('VACANCY_SERVICE_OWNED_COLUMNS são exatamente as 9 do CHECK 525', () => {
      expect([...VACANCY_SERVICE_OWNED_COLUMNS].sort()).toEqual(
        ['schedule', 'providers_needed', 'age_range_min', 'age_range_max', 'required_sex', 'required_professions',
          'required_experience', 'work_schedule', 'payment_day'].sort(),
      );
      expect(VACANCY_SERVICE_OWNED_COLUMNS).toHaveLength(9);
    });
    it('vaga cheia: toda column de vacancyClear ∈ lista e são as 9', () => {
      const r = linkExistingVacancyPlan(
        emptyVacancy({
          required_professions: ['AT'], required_experience: '5', work_schedule: 'full-time', payment_day: '10',
          required_sex: 'F', providers_needed: '2', age_range_min: 20, age_range_max: 29, schedule: [{ d: 1 }],
          patient_address_id: 'a1',
        }),
        emptyService(),
        yes,
      );
      const cols = r.vacancyClear.map((c) => c.column);
      cols.forEach((c) => expect(VACANCY_SERVICE_OWNED_COLUMNS).toContain(c));
      expect([...cols].sort()).toEqual([...VACANCY_SERVICE_OWNED_COLUMNS].sort());
      for (const nome of ['salary_text', 'worker_profile_sought', 'title', 'description']) {
        expect(cols as string[]).not.toContain(nome);
      }
    });
    it('vacancyClear só tem colunas não vazias, com o valor antigo', () => {
      const r = linkExistingVacancyPlan(emptyVacancy({ payment_day: '10', work_schedule: '  ', required_professions: [] }), emptyService(), yes);
      expect(r.vacancyClear).toEqual([{ column: 'payment_day', before: '10' }]);
    });
  });

  describe('rows', () => {
    it('omitem o que não muda (vaga vazia e serviço vazio; vaga == serviço)', () => {
      const r = linkExistingVacancyPlan(
        emptyVacancy({ payment_day: '10' }),
        emptyService({ payment_day: '10' }),
        yes,
      );
      expect(r.rows).toEqual([]);
    });
    it('serviço preenchido e vaga vazia: row mostra o valor do serviço', () => {
      const r = linkExistingVacancyPlan(emptyVacancy(), emptyService({ payment_day: '20' }), yes);
      expect(r.rows).toEqual([{ field: 'payment_day', vacancyValue: null, effectiveValue: '20', origin: 'SERVICE' }]);
    });
  });

  it('effective: caso misto (serviço + feed + recusado)', () => {
    const r = linkExistingVacancyPlan(
      emptyVacancy({ required_experience: '5', payment_day: '10', required_sex: 'Femenino', required_professions: ['AT'] }),
      emptyService({ required_experience: '9', work_schedule: 'part-time' }),
      (f) => f !== 'required_sex',
    );
    expect(r.effective.recruitmentFields).toEqual({
      requiredProfessions: ['AT'],
      requiredSex: null,
      requiredExperience: '9',
      workSchedule: 'part-time',
      paymentDay: '10',
    });
    expect(r.serviceFeed).toEqual({ payment_day: '10', required_professions: ['AT'] });
    expect(r.warnings).toEqual([{ field: 'required_sex', code: 'VALUE_OUTSIDE_SERVICE_DOMAIN' }]);
  });

  it('campo alimentado pela vaga com o MESMO valor NÃO gera linha (required_sex, age_range, address)', () => {
    const r = linkExistingVacancyPlan(
      emptyVacancy({ required_sex: 'F', age_range_min: 20, age_range_max: 29, patient_address_id: 'a1' }),
      emptyService(),
      yes,
    );
    expect(r.serviceFeed).toMatchObject({ required_sex: 'F', provider_age_band: 'AGE_20_30', address_id: 'a1' });
    expect(r.rows).toEqual([]);
  });

  it('serviço com valor diferente → 1 linha origin SERVICE', () => {
    const r = linkExistingVacancyPlan(emptyVacancy({ required_sex: 'F' }), emptyService({ required_sex: 'M' }), yes);
    expect(r.rows).toEqual([{ field: 'required_sex', vacancyValue: 'F', effectiveValue: 'M', origin: 'SERVICE' }]);
  });

  it('tudo igual → rows vazio', () => {
    const r = linkExistingVacancyPlan(
      emptyVacancy({ required_sex: 'F', required_experience: '5', patient_address_id: 'a1' }),
      emptyService({ required_sex: 'F', required_experience: '5', address_id: 'a1' }),
      yes,
    );
    expect(r.rows).toEqual([]);
  });

  it('direção única: serviceFeed só tem chave de campo cujo serviço estava vazio', () => {
    const vac = emptyVacancy({
      required_professions: ['AT'], required_experience: '5', work_schedule: 'full-time', payment_day: '10',
      required_sex: 'F', providers_needed: '2', age_range_min: 20, age_range_max: 29, patient_address_id: 'a1',
    });
    const full = emptyService({
      required_professions: ['TO'], required_experience: '9', work_schedule: 'part-time', payment_day: '20',
      required_sex: 'M', providers_needed: 7, provider_age_band: 'AGE_45_PLUS', address_id: 'a1',
    });
    expect(linkExistingVacancyPlan(vac, full, yes).serviceFeed).toEqual({});
    // cada campo isolado: serviço vazio só nele => só ele entra
    const cases: Array<[Partial<ServiceLinkTarget>, string]> = [
      [{ required_professions: null }, 'required_professions'],
      [{ required_experience: null }, 'required_experience'],
      [{ work_schedule: null }, 'work_schedule'],
      [{ payment_day: null }, 'payment_day'],
      [{ required_sex: null }, 'required_sex'],
      [{ providers_needed: null }, 'providers_needed'],
      [{ provider_age_band: null }, 'provider_age_band'],
      [{ address_id: null }, 'address_id'],
    ];
    for (const [blank, key] of cases) {
      expect(Object.keys(linkExistingVacancyPlan(vac, { ...full, ...blank }, yes).serviceFeed)).toEqual([key]);
    }
  });
});
