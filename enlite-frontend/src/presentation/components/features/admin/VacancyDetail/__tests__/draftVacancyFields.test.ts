import { describe, it, expect } from 'vitest';
import {
  DRAFT_TODO_FIELDS,
  DRAFT_TODO_TOTAL,
  KNOWN_LOCKED_FIELDS,
  assertKnownLockedFields,
  missingDraftFieldsCount,
  type DraftVacancyLike,
} from '../draftVacancyFields';

/** Uma vaga com TUDO preenchido — ponto de partida de cada teste, que sabota só o campo que quer. */
function fullVacancy(overrides: Partial<DraftVacancyLike> = {}): DraftVacancyLike {
  return {
    required_professions: ['CAREGIVER'],
    required_sex: 'F',
    worker_profile_sought: 'Perfil calmo, com experiência em TEA',
    worker_attributes: 'Paciente, pontual',
    required_experience: '2 años',
    payment_day: 'Día 20',
    closes_at: '2026-10-01',
    meet_link_1: 'https://meet.google.com/abc-defg-hij',
    meet_link_2: null,
    meet_link_3: null,
    ...overrides,
  };
}

describe('draftVacancyFields — a lista fixa e a contagem derivada (fase 2, F3)', () => {
  it('M é sempre 8 — o tamanho da lista fixa, não algo que varia com o payload', () => {
    expect(DRAFT_TODO_TOTAL).toBe(8);
    expect(DRAFT_TODO_FIELDS).toHaveLength(8);
  });

  it('vaga recém-nascida do foguete (tudo o que o recrutamento preenche ainda vazio) → faltam os 8', () => {
    const freshDraft: DraftVacancyLike = {
      required_professions: [],
      required_sex: null,
      worker_profile_sought: null,
      worker_attributes: null,
      required_experience: null,
      payment_day: null,
      closes_at: null,
      meet_link_1: null,
      meet_link_2: null,
      meet_link_3: null,
    };
    expect(missingDraftFieldsCount(freshDraft)).toBe(8);
  });

  it('vaga com tudo preenchido → faltam 0', () => {
    expect(missingDraftFieldsCount(fullVacancy())).toBe(0);
  });

  it('required_professions vazio ([]) conta como vazio mesmo não sendo null (F2)', () => {
    const v = fullVacancy({ required_professions: [] });
    expect(missingDraftFieldsCount(v)).toBe(1);
  });

  it('links de Meet: qualquer um dos 3 preenchido já conta como "não vazio"', () => {
    const nenhum = fullVacancy({ meet_link_1: null, meet_link_2: null, meet_link_3: null });
    expect(missingDraftFieldsCount(nenhum)).toBe(1);

    const so_o_2 = fullVacancy({ meet_link_1: null, meet_link_2: 'https://meet.google.com/x', meet_link_3: null });
    expect(missingDraftFieldsCount(so_o_2)).toBe(0);
  });

  it('variar SÓ um campo muda a contagem em exatamente 1 — prova que cada item é independente', () => {
    const base = fullVacancy();
    for (const field of DRAFT_TODO_FIELDS) {
      const sabotado = { ...base } as Record<string, unknown>;
      if (field.key === 'meet_links') {
        sabotado.meet_link_1 = null;
        sabotado.meet_link_2 = null;
        sabotado.meet_link_3 = null;
      } else if (field.key === 'required_professions') {
        sabotado.required_professions = [];
      } else {
        sabotado[field.key] = null;
      }
      expect({ field: field.key, missing: missingDraftFieldsCount(sabotado as DraftVacancyLike) }).toEqual({
        field: field.key,
        missing: 1,
      });
    }
  });

  it('assertKnownLockedFields aceita os 8 campos de SOURCE_LOCKED_FIELDS (paridade com o backend)', () => {
    expect(() => assertKnownLockedFields([...KNOWN_LOCKED_FIELDS])).not.toThrow();
  });

  it('assertKnownLockedFields aceita lista vazia (vaga sem `contracted_service_id` — F6 do backend)', () => {
    expect(() => assertKnownLockedFields([])).not.toThrow();
    expect(() => assertKnownLockedFields(null)).not.toThrow();
    expect(() => assertKnownLockedFields(undefined)).not.toThrow();
  });

  it('🔴 sabotagem: locked_fields com um nome fora da lista conhecida FALHA nomeando o campo', () => {
    expect(() => assertKnownLockedFields(['case_number', 'daily_obs'])).toThrowError(/daily_obs/);
  });
});
