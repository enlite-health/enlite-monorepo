/** Spec 084 F2: a lista esconde as dadas de baja por padrão; "Mostrar dadas de baja" e o filtro de status as mostram (só consulta). */
import { buildListVacanciesQuery, mapStatus, mapVacancyListRow, type VacancyListRow } from '../vacancyListHelpers';

const base = { limit: '20', offset: '0' };

describe('lista de vacantes — dadas de baja (spec 084 F2)', () => {
  it('padrão: NENHUMA baixada na lista (`jp.status != DE_BAJA`)', () => {
    const { baseQuery } = buildListVacanciesQuery(base);
    expect(baseQuery).toContain("AND jp.status != 'DE_BAJA'");
  });

  it('include_baja=true: o filtro padrão some e as baixadas aparecem', () => {
    for (const v of [true, 'true', '1']) {
      expect(buildListVacanciesQuery({ ...base, includeBaja: v }).baseQuery).not.toContain("jp.status != 'DE_BAJA'");
    }
    expect(buildListVacanciesQuery({ ...base, includeBaja: 'false' }).baseQuery).toContain("jp.status != 'DE_BAJA'");
  });

  it('filtro de status "Dada de baja" mostra SÓ as baixadas (parametrizado, sem esconder)', () => {
    const q = buildListVacanciesQuery({ ...base, status: 'DE_BAJA' });
    expect(q.baseQuery).toContain('AND jp.status = $1');
    expect(q.params).toEqual(['DE_BAJA']);
    expect(q.baseQuery).not.toContain("jp.status != 'DE_BAJA'");
  });

  it('lista manual do Talentum (R13): filtro talentum_manual', () => {
    expect(buildListVacanciesQuery({ ...base, talentumManual: 'true' }).baseQuery).toContain("talentum_pause_state IN ('MANUAL_PAUSE', 'MANUAL_RESUME')");
    expect(buildListVacanciesQuery(base).baseQuery).not.toContain('talentum_pause_state IN');
  });

  it('a linha traz o motivo, se tem serviço e o estado do Talentum; DE_BAJA tem rótulo (não "Desconocido")', () => {
    expect(mapStatus('DE_BAJA')).toBe('Dada de baja');
    const row = { id: 'v', status: 'DE_BAJA', baja_reason: 'MANUAL', has_service: false, talentum_pause_state: 'MANUAL_PAUSE', vacancy_number: 1 } as unknown as VacancyListRow;
    expect(mapVacancyListRow(row)).toMatchObject({ statusRaw: 'DE_BAJA', bajaReason: 'MANUAL', hasService: false, talentumPauseState: 'MANUAL_PAUSE' });
  });
});
