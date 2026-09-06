import { buildListVacanciesQuery } from '../vacancyListHelpers';

describe('buildListVacanciesQuery — busca por nome do paciente (D286 fase 2 / lex P5)', () => {
  it('por padrão (engine não decidiu) a busca casa nome, caso, número e título — como antes', () => {
    const q = buildListVacanciesQuery({ search: 'Juan', limit: '20', offset: '0' } as never);
    expect(q.baseQuery).toMatch(/p\.first_name ILIKE \$1/);
    expect(q.baseQuery).toMatch(/p\.last_name ILIKE \$1/);
    expect(q.params[0]).toBe('%Juan%');
  });

  it('sem patient_identity:read a busca NÃO toca first_name/last_name — a lista redigida não vira oráculo', () => {
    const q = buildListVacanciesQuery({ search: 'Juan', limit: '20', offset: '0' } as never, { searchByPatientName: false });
    expect(q.baseQuery).not.toMatch(/first_name ILIKE/);
    expect(q.baseQuery).not.toMatch(/last_name ILIKE/);
    expect(q.baseQuery).toMatch(/jp\.case_number::TEXT ILIKE \$1/);
    expect(q.baseQuery).toMatch(/jp\.title ILIKE \$1/);
    expect(q.params[0]).toBe('%Juan%');
  });
});
