/**
 * C1 do veredito do `lex` sobre a F2 — o diagnóstico do paciente sai de
 * `GET /api/admin/vacancies/:id` **antes** de `vacancy:read` decidir qualquer
 * coisa.
 *
 * ⚠️ A guarda é sobre a QUERY, não sobre a resposta (D170: a fronteira, não o
 * campo lembrado). Uma asserção do tipo "a resposta não tem `patient_diagnosis`"
 * ficaria verde com o `SELECT` intacto e um `delete` no fim do handler — e aí o
 * texto clínico teria vindo do banco, existido em memória e podido cair num log
 * de erro de query. O que a C1 exige é que ele **não seja buscado**.
 *
 * A fixture carrega o dado proibido de propósito: guarda com fixture limpa não
 * prova nada, porque `not.toContain` passa sobre o que nunca esteve lá.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { Request, Response } from 'express';
import { VacanciesController } from '../VacanciesController';
import { RecruitmentAnalyticsController } from '../RecruitmentAnalyticsController';

const DIAGNOSTICO = 'Esclerose múltipla, surto-remissão';

function reqRes(params: Record<string, string>): [Request, Response] {
  const req = { params, body: {}, query: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

/** TODAS as queries da request, não `calls[0]` — o vazamento pode estar na 3ª. */
function sqlDeTodasAsQueries(): string {
  return mockQuery.mock.calls.map((c) => String(c[0])).join('\n---\n');
}

describe('C1 — o diagnóstico do paciente não é sequer BUSCADO', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET /vacancies/:id: nenhuma query pede `p.diagnosis`', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'jp-1', vacancy_number: 42, schedule: null,
        // O banco DEVOLVERIA isto se o SELECT pedisse. A fixture carrega o dado
        // proibido para que a asserção tenha o que reprovar.
        patient_diagnosis: DIAGNOSTICO,
        diagnosis: DIAGNOSTICO,
        encuadres: null, publications: null,
        service_type: null, required_professions: null, social_short_links: null,
      }],
    });

    const [req, res] = reqRes({ id: 'jp-1' });
    await new VacanciesController().getVacancyById(req, res);

    const sql = sqlDeTodasAsQueries();
    expect(sql).not.toMatch(/p\.diagnosis/);
    expect(sql).not.toMatch(/patient_diagnosis/);
    // E a query nem sequer alcança a coluna por outro nome.
    expect(sql).not.toMatch(/\bdiagnosis\b/);
    expect((res.json as jest.Mock).mock.calls[0][0].success).toBe(true);
  });

  it('GET /recruitment/case/:caseNumber: o irmão do mesmo defeito também não pede', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const [req, res] = reqRes({ caseNumber: '442' });
    await new RecruitmentAnalyticsController().getCaseAnalysis(req, res);

    const sql = sqlDeTodasAsQueries();
    expect(sql).not.toMatch(/p\.diagnosis/);
    expect(sql).not.toMatch(/patient_diagnosis/);
    expect(mockQuery).toHaveBeenCalled();
  });

  it('o resto da vaga continua saindo — tirar o clínico não pode esvaziar a tela', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'jp-1', vacancy_number: 42, schedule: null,
        patient_first_name: 'Paciente', dependency_level: 'ALTA',
        patient_zone: 'Palermo', insurance_verified: true,
        encuadres: null, publications: null,
        service_type: null, required_professions: null, social_short_links: null,
      }],
    });

    const [req, res] = reqRes({ id: 'jp-1' });
    await new VacanciesController().getVacancyById(req, res);

    // `dependency_level` FICA: é grau de dependência operacional, não diagnóstico.
    expect((res.json as jest.Mock).mock.calls[0][0].data).toMatchObject({
      id: 'jp-1', dependency_level: 'ALTA', patient_zone: 'Palermo', insurance_verified: true,
    });
  });
});
