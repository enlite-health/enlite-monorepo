/**
 * ProviderAgeBandMapping — fonte única do mapa franja→vaga (spec 015, US-A6.2; D254 item 6).
 */
import {
  vacancyRangeForProviderAgeBand,
  PROVIDER_AGE_BAND_TO_VACANCY_RANGE,
  CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND,
} from '../ProviderAgeBandMapping';
import { PROVIDER_AGE_BANDS } from '../enums/ContractedService';

describe('vacancyRangeForProviderAgeBand', () => {
  it('ANY → {min:null, max:null} (edad indistinta, explícito)', () => {
    expect(vacancyRangeForProviderAgeBand('ANY')).toEqual({ min: null, max: null });
  });

  it('AGE_20_30 → {min:20, max:29}', () => {
    expect(vacancyRangeForProviderAgeBand('AGE_20_30')).toEqual({ min: 20, max: 29 });
  });

  it('AGE_30_45 → {min:30, max:44} (30 cai só aqui, não em AGE_20_30 — resolve a ambiguidade do contrato)', () => {
    expect(vacancyRangeForProviderAgeBand('AGE_30_45')).toEqual({ min: 30, max: 44 });
  });

  it('AGE_45_PLUS → {min:45, max:null}', () => {
    expect(vacancyRangeForProviderAgeBand('AGE_45_PLUS')).toEqual({ min: 45, max: null });
  });

  it('null (não informado) → {min:null, max:null}, não toca a vaga', () => {
    expect(vacancyRangeForProviderAgeBand(null)).toEqual({ min: null, max: null });
  });

  it('undefined (mesmo tratamento de null) → {min:null, max:null}', () => {
    expect(vacancyRangeForProviderAgeBand(undefined)).toEqual({ min: null, max: null });
  });

  it('os 4 valores do enum têm entrada no mapa — nenhum cai no default do Record', () => {
    for (const band of PROVIDER_AGE_BANDS) {
      expect(PROVIDER_AGE_BAND_TO_VACANCY_RANGE[band]).toBeDefined();
    }
  });

  it('os intervalos de VAGA (20-29 / 30-44 / 45+) não se sobrepõem', () => {
    expect(PROVIDER_AGE_BAND_TO_VACANCY_RANGE.AGE_20_30.max).toBeLessThan(
      PROVIDER_AGE_BAND_TO_VACANCY_RANGE.AGE_30_45.min as number,
    );
  });
});

describe('CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND — grafia viva medida em contracts/clickup-fields.md', () => {
  it('mapeia os 4 rótulos vivos do ClickUp para o enum canônico', () => {
    expect(CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND['Edad Indistinta']).toBe('ANY');
    expect(CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND['20 a 30 Años']).toBe('AGE_20_30');
    expect(CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND['30 a 45 Años']).toBe('AGE_30_45');
    expect(CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND['+ 45 Años']).toBe('AGE_45_PLUS');
  });

  it('todo valor do mapa é um ProviderAgeBand reconhecido', () => {
    for (const band of Object.values(CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND)) {
      expect(PROVIDER_AGE_BANDS).toContain(band);
    }
  });
});
