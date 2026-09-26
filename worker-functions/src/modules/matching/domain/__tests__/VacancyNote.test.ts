import { VACANCY_NOTE_CATEGORIES, createVacancyNoteSchema } from '../VacancyNote';

const nowIso = () => new Date().toISOString();
const isoDaysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const isoMinutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60 * 1000).toISOString();

const base = {
  occurredAt: nowIso(),
  category: 'DIVULGACAO' as const,
  contact: 'grupo Facebook X',
  body: 'Publicado no grupo.',
};

describe('createVacancyNoteSchema — categoria', () => {
  it.each(VACANCY_NOTE_CATEGORIES)('aceita a categoria %p', (category) => {
    expect(createVacancyNoteSchema.safeParse({ ...base, category }).success).toBe(true);
  });

  it('recusa categoria fora do enum', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, category: 'BLOQUEADO' }).success).toBe(false);
  });
});

describe('createVacancyNoteSchema — contact', () => {
  it('recusa contact só de espaços', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, contact: '    ' }).success).toBe(false);
  });

  it('recusa contact com 121 caracteres', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, contact: 'a'.repeat(121) }).success).toBe(false);
  });

  it('aceita contact com 120 caracteres', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, contact: 'a'.repeat(120) }).success).toBe(true);
  });
});

describe('createVacancyNoteSchema — body', () => {
  it('recusa body vazio', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, body: '' }).success).toBe(false);
  });

  it('recusa body com 2001 caracteres', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, body: 'a'.repeat(2001) }).success).toBe(false);
  });

  it('aceita body com 2000 caracteres', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, body: 'a'.repeat(2000) }).success).toBe(true);
  });
});

describe('createVacancyNoteSchema — occurredAt', () => {
  it('aceita data de 5 dias atrás', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, occurredAt: isoDaysAgo(5) }).success).toBe(true);
  });

  it('recusa now + 10 min', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, occurredAt: isoMinutesFromNow(10) }).success).toBe(false);
  });

  it('recusa string sem fuso', () => {
    expect(createVacancyNoteSchema.safeParse({ ...base, occurredAt: '2026-09-23T10:00:00' }).success).toBe(false);
  });
});
