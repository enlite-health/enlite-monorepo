/**
 * semaforo-da-vaga F2 (D811, P2): a lista traz `semaphore_n` MATERIALIZADO UMA vez (LATERAL com o fragmento do dono), a cor
 * sai de `corDoSemaforoSql(alias)` — nunca da subquery repetida — e o filtro `semaphore` (CSV validado contra `CORES`)
 * nunca devolve vaga baixada.
 */
import { semaforoContagemSql } from '../../../infrastructure/vacancySemaphoreSql';
import { corDoSemaforoSql, CORES } from '../../../domain/vacancySemaphore';
import {
  buildListVacanciesQuery, mapVacancyListRow, VacancySemaphoreFilterError, type VacancyListRow,
} from '../vacancyListHelpers';

const base = { countries: ['AR'], limit: '20', offset: '0' };
const row = (over: Partial<VacancyListRow>): VacancyListRow => ({
  id: 'v', patient_first_name: null, patient_last_name: null, case_number: 1, case_ordinal: null, vacancy_number: 1,
  status: 'SEARCHING', is_draft: false, dias_aberto: 0, convidados: 0, postulados: 0, selecionados: 0, faltantes: 0, ...over,
});

describe('buildListVacanciesQuery — semáforo', () => {
  it('materializa `n` UMA vez, com o fragmento do dono, num LATERAL', () => {
    const { baseQuery } = buildListVacanciesQuery(base);
    expect(baseQuery).toContain('semaphore_n');
    expect(baseQuery).toContain(`LEFT JOIN LATERAL (SELECT ${semaforoContagemSql('jp.id')} AS n) sem ON true`);
    expect(baseQuery.split(semaforoContagemSql('jp.id')).length - 1).toBe(1);
  });

  it('sem filtro, nada de semáforo no WHERE; com filtro, a cor sai do SQL gerado sobre o ALIAS e a baixada nunca entra', () => {
    expect(buildListVacanciesQuery(base).baseQuery).not.toContain(corDoSemaforoSql('sem.n'));
    const q = buildListVacanciesQuery({ ...base, semaphore: 'red,green', includeBaja: 'true' });
    expect(q.baseQuery).toContain(`AND ${corDoSemaforoSql('sem.n')} = ANY($1::text[])`);
    expect(q.baseQuery).toContain(`AND jp.status <> 'DE_BAJA'`);
    expect(q.params[0]).toEqual(['red', 'green']);
    expect(q.baseQuery.split(semaforoContagemSql('jp.id')).length - 1).toBe(1);
  });

  it('o filtro aceita exatamente as cores da tabela; qualquer outra recusa com código estável e as duas línguas', () => {
    CORES.forEach((c) => expect(() => buildListVacanciesQuery({ ...base, semaphore: c })).not.toThrow());
    for (const ruim of ['blue', 'red,blue', '', 'red,,green', "red'; DROP TABLE job_postings;--"]) {
      let erro: unknown;
      try { buildListVacanciesQuery({ ...base, semaphore: ruim }); } catch (e) { erro = e; }
      expect(erro).toBeInstanceOf(VacancySemaphoreFilterError);
      const e = erro as VacancySemaphoreFilterError;
      expect(e.code).toBe('VACANCY_SEMAPHORE_INVALID');
      expect(e.messages.es).toEqual(expect.any(String));
      expect(e.messages['pt-BR']).toEqual(expect.any(String));
    }
  });
});

describe('mapVacancyListRow — semaphore', () => {
  it('n e cor saem do dono; o `n` vem como número', () => {
    expect(mapVacancyListRow(row({ semaphore_n: '5' })).semaphore).toEqual({ n: 5, color: 'yellow' });
    expect(mapVacancyListRow(row({ semaphore_n: 0 })).semaphore).toEqual({ n: 0, color: 'red' });
    expect(mapVacancyListRow(row({ semaphore_n: 10 })).semaphore).toEqual({ n: 10, color: 'green' });
  });
  it('baixada = null (P2: um sentido só), mesmo com candidaturas', () => {
    expect(mapVacancyListRow(row({ status: 'DE_BAJA', semaphore_n: 7 })).semaphore).toBeNull();
  });
});
