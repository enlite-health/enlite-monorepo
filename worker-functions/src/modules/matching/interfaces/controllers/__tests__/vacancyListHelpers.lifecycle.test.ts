/**
 * estado-automatico-do-paciente F2 (D3/E6/E7) + semaforo-da-vaga F4: a lista traz `lifecycle` (rascunho|baja|null; SQL gerado da tabela do dono) e `patient_status`
 * (`p.status` por join, NUNCA `jp.status`), filtra por ciclo de vida e por estado do paciente (este só com `patient:read`).
 */
import { cicloDeVidaSql } from '../../../domain/vacancyLifecycle';
import { buildListVacanciesQuery, mapVacancyListRow, PatientStatusFilterForbiddenError, VacancyLifecycleFilterError, type VacancyListRow } from '../vacancyListHelpers';
import { projectPatientInVacancy } from '../../../application/patientInVacancyProjection';

const base = { countries: ['AR'], limit: '20', offset: '0' };

describe('buildListVacanciesQuery — E7: os dois filtros novos', () => {
  it('SELECT: estado do paciente vem de p.status por join; ciclo de vida do SQL gerado da tabela', () => {
    const { baseQuery } = buildListVacanciesQuery(base);
    expect(baseQuery).toContain('p.status AS patient_status');
    expect(baseQuery).not.toMatch(/jp\.status\s+AS\s+patient_status/);
    expect(baseQuery).toContain(`${cicloDeVidaSql('jp')} AS lifecycle`);
    expect(baseQuery).toContain('LEFT JOIN patients p ON jp.patient_id = p.id');
  });

  it('lifecycle válido (rascunho|baja) filtra pelo SQL do dono', () => {
    const ok = buildListVacanciesQuery({ ...base, lifecycle: 'rascunho' });
    expect(ok.baseQuery).toContain(`AND ${cicloDeVidaSql('jp')} = $1`);
    expect(ok.params[0]).toBe('rascunho');
  });

  it('lifecycle fora de rascunho|baja → 400 VACANCY_LIFECYCLE_INVALID (es + pt-BR), nunca ignorado nem vira SQL', () => {
    for (const velho of ['aberta', 'pausada', 'cerrada', "x'; DROP TABLE job_postings;--"]) {
      let erro: unknown;
      try { buildListVacanciesQuery({ ...base, lifecycle: velho }); } catch (e) { erro = e; }
      expect(erro).toBeInstanceOf(VacancyLifecycleFilterError);
      expect(erro).toMatchObject({ code: 'VACANCY_LIFECYCLE_INVALID' });
      expect((erro as VacancyLifecycleFilterError).messages.es).toMatch(/rascunho, baja/);
      expect((erro as VacancyLifecycleFilterError).messages['pt-BR']).toMatch(/rascunho, baja/);
    }
    expect(() => buildListVacanciesQuery({ ...base, lifecycle: '' })).not.toThrow(); // vazio = não pediu
    expect(() => buildListVacanciesQuery(base)).not.toThrow();
  });

  it('lifecycle=baja mostra as baixadas (como status=DE_BAJA); rascunho continua escondendo as baixadas', () => {
    expect(buildListVacanciesQuery({ ...base, lifecycle: 'baja' }).baseQuery).not.toContain("jp.status != 'DE_BAJA'");
    expect(buildListVacanciesQuery({ ...base, lifecycle: 'rascunho' }).baseQuery).toContain("jp.status != 'DE_BAJA'");
  });

  it('patientStatus filtra por p.status (parametrizado) com a célula', () => {
    const q = buildListVacanciesQuery({ ...base, patientStatus: 'SEARCHING' }, { canFilterByPatientStatus: true });
    expect(q.baseQuery).toContain('AND p.status = $1');
    expect(q.params[0]).toBe('SEARCHING');
  });

  it('patientStatus SEM a célula → recusa nomeando o campo e a célula (403 no controller), nunca ignorado em silêncio', () => {
    let erro: unknown;
    try {
      buildListVacanciesQuery({ ...base, patientStatus: 'SEARCHING' }, { canFilterByPatientStatus: false });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(PatientStatusFilterForbiddenError);
    expect(erro).toMatchObject({ field: 'patientStatus', cell: 'patient:read' });
    // sem o filtro, sem a célula: lista normal
    expect(() => buildListVacanciesQuery(base, { canFilterByPatientStatus: false })).not.toThrow();
  });

  it('o parâmetro antigo `status` continua aceito (084 e vacancies-api o usam) e a tela só deixa de oferecê-lo', () => {
    expect(buildListVacanciesQuery({ ...base, status: 'DE_BAJA' }).baseQuery).toContain('jp.status = $1');
  });
});

describe('mapVacancyListRow + projeção — E6 na lista', () => {
  const linha = (extra: Partial<VacancyListRow> = {}): VacancyListRow => ({
    id: 'v1', patient_first_name: 'Ana', patient_last_name: 'Lima QA', case_number: 7, case_ordinal: 1, vacancy_number: 1,
    status: 'SEARCHING_REPLACEMENT', is_draft: false, lifecycle: null, patient_id: 'p1', patient_status: 'SEARCHING',
    dias_aberto: 1, convidados: 0, postulados: 0, selecionados: 0, faltantes: null, ...extra,
  });

  it('com a célula: patient_status sai e a vaga viva (até a de status legado) fica sem selo (lifecycle null)', () => {
    const out = mapVacancyListRow(projectPatientInVacancy(linha(), ['vacancy:read', 'patient:read']));
    expect(out).toMatchObject({ patient_status: 'SEARCHING', lifecycle: null, patient_id: 'p1' });
    expect(out).not.toHaveProperty('redacted');
  });

  it('sem patient:read → patient_status null + redacted.patient (marcador constante)', () => {
    const out = mapVacancyListRow(projectPatientInVacancy(linha(), ['vacancy:read']));
    expect(out).toMatchObject({ patient_status: null, redacted: { patient: true } });
  });

  it('vaga sem paciente → SEM a chave patient_status (null só significa "sem célula") e patient_id null', () => {
    const out = mapVacancyListRow(projectPatientInVacancy(linha({ patient_id: null, patient_status: null }), ['vacancy:read', 'patient:read']));
    expect(out).not.toHaveProperty('patient_status');
    expect(out.patient_id).toBeNull();
  });

  it('on_hold_note (clínico) nunca entra na lista de vagas', () => {
    expect(buildListVacanciesQuery(base).baseQuery).not.toMatch(/on_hold_note/i);
  });
});
