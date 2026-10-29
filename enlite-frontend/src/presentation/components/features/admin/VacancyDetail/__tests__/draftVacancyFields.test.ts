import { describe, it, expect, vi } from 'vitest';
import {
  DRAFT_TODO_FIELDS,
  DRAFT_TODO_TOTAL,
  KNOWN_LOCKED_FIELDS,
  assertKnownLockedFields,
  draftTodoFields,
  draftTodoTotal,
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
    ...overrides,
  };
}

describe('draftVacancyFields — a lista fixa e a contagem derivada (fase 2, F3)', () => {
  it('M é sempre 7 — o tamanho da lista fixa, não algo que varia com o payload', () => {
    expect(DRAFT_TODO_TOTAL).toBe(7);
    expect(DRAFT_TODO_FIELDS).toHaveLength(7);
  });

  it('vaga recém-nascida do foguete (tudo o que o recrutamento preenche ainda vazio) → faltam os 7', () => {
    const freshDraft: DraftVacancyLike = {
      required_professions: [],
      required_sex: null,
      worker_profile_sought: null,
      worker_attributes: null,
      required_experience: null,
      payment_day: null,
      closes_at: null,
    };
    expect(missingDraftFieldsCount(freshDraft)).toBe(7);
  });

  it('vaga com tudo preenchido → faltam 0', () => {
    expect(missingDraftFieldsCount(fullVacancy())).toBe(0);
  });

  it('required_professions vazio ([]) conta como vazio mesmo não sendo null (F2)', () => {
    const v = fullVacancy({ required_professions: [] });
    expect(missingDraftFieldsCount(v)).toBe(1);
  });

  it('a vaga não tem link de reunião: rascunho sem nenhum campo meet_* conta como completo (spec 068)', () => {
    expect(DRAFT_TODO_FIELDS.map((f) => f.key)).not.toContain('meet_links');
    expect(Object.keys(fullVacancy()).filter((k) => k.startsWith('meet'))).toEqual([]);
    expect(missingDraftFieldsCount(fullVacancy())).toBe(0);
  });

  it('variar SÓ um campo muda a contagem em exatamente 1 — prova que cada item é independente', () => {
    const base = fullVacancy();
    for (const field of DRAFT_TODO_FIELDS) {
      const sabotado = { ...base } as Record<string, unknown>;
      if (field.key === 'required_professions') {
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

  it('assertKnownLockedFields aceita os 13 campos de SOURCE_LOCKED_FIELDS (paridade com o backend), sem warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(KNOWN_LOCKED_FIELDS).toHaveLength(13);
    expect(() => assertKnownLockedFields([...KNOWN_LOCKED_FIELDS])).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('assertKnownLockedFields aceita lista vazia (vaga sem `contracted_service_id` — F6 do backend)', () => {
    expect(() => assertKnownLockedFields([])).not.toThrow();
    expect(() => assertKnownLockedFields(null)).not.toThrow();
    expect(() => assertKnownLockedFields(undefined)).not.toThrow();
  });

  it('🔴 sabotagem: locked_fields com um nome fora da lista conhecida avisa 1x nomeando o campo e NÃO lança', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertKnownLockedFields(['case_number', 'xpto'])).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/xpto/);
    warn.mockRestore();
  });
});

describe('draftVacancyFields — vaga com serviço contratado (057/T4.4)', () => {
  const comServico = (o: Partial<DraftVacancyLike> = {}) =>
    fullVacancy({ contracted_service_id: 'svc-1', work_schedule: 'L-V', ...o });

  it('com serviço: os 4 itens saem e entra 1 item único; total 4 e a contagem do item = campos vazios dos 5', () => {
    const v = comServico({ required_sex: null, payment_day: null, work_schedule: null });
    const keys = draftTodoFields(v).map((f) => f.key);
    expect(keys).toEqual([
      'service_recruitment_fields',
      'worker_profile_sought',
      'worker_attributes',
      'closes_at',
    ]);
    expect(draftTodoTotal(v)).toBe(4);
    const item = draftTodoFields(v)[0];
    expect(item.labelParams?.(v)).toEqual({ count: 3 });
    expect(item.isEmpty(v)).toBe(true);
    expect(missingDraftFieldsCount(v)).toBe(1);
  });

  it('com serviço e os 5 já preenchidos: o item aparece feito (isEmpty=false), faltam 0', () => {
    const v = comServico();
    expect(draftTodoFields(v)[0].isEmpty(v)).toBe(false);
    expect(missingDraftFieldsCount(v)).toBe(0);
  });

  it('sem serviço: os 7 itens de sempre, inalterado', () => {
    const v = fullVacancy({ contracted_service_id: null });
    expect(draftTodoFields(v)).toBe(DRAFT_TODO_FIELDS);
    expect(draftTodoTotal(v)).toBe(7);
    expect(draftTodoFields(v).map((f) => f.key)).not.toContain('service_recruitment_fields');
  });
});
