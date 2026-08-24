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
import { TEXTO_CLINICO, esperaSemVazamentoClinico } from '../../../__tests__/guardaVazamentoClinico';

/**
 * O canário é o MESMO texto da guarda compartilhada (D170). Vocabulário único:
 * canário próprio por teste é como o defeito do `utm_content` reincidiu três
 * vezes — cada guarda procurava a palavra que o autor dela lembrou.
 */
const DIAGNOSTICO = TEXTO_CLINICO;

/**
 * A regex clínica da casa, aplicada à query REAL capturada no mock.
 *
 * ⚠️ NÃO uso `esperaSqlSemDadoClinico` aqui, e a diferença é de propósito: ela
 * também reprova `JOIN patients`, o que é certo para o caminho do short-link
 * (que não deve tocar paciente nenhum) e ERRADO para esta rota, que precisa do
 * paciente para nome, zona e nível de dependência. Reusar lá reprovaria código
 * certo — e gate que reprova o certo se aprende a ignorar (D172).
 */
const VOCABULARIO_CLINICO = /diagnosis|diagnostico|patholog|patolog/i;

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
  // Contagem zero é falha, nunca sucesso: sem query executada, todo
  // `not.toMatch` abaixo passa no vácuo. A guarda da casa faz o mesmo.
  if (mockQuery.mock.calls.length === 0) {
    throw new Error('nenhuma query foi executada — a asserção passaria no vácuo');
  }
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

    expect(sqlDeTodasAsQueries()).not.toMatch(VOCABULARIO_CLINICO);
    expect((res.json as jest.Mock).mock.calls[0][0].success).toBe(true);
  });

  it('GET /recruitment/case/:caseNumber: o irmão do mesmo defeito também não pede', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const [req, res] = reqRes({ caseNumber: '442' });
    await new RecruitmentAnalyticsController().getCaseAnalysis(req, res);

    expect(sqlDeTodasAsQueries()).not.toMatch(VOCABULARIO_CLINICO);
  });

  it('o corpo é EXATAMENTE o que a query trouxe — por isso a guarda é sobre a query', async () => {
    // ⚠️ `getVacancyById` faz `{ ...row }`: a rota não tem allowlist de campo,
    // ela devolve o que o `SELECT` trouxer. Duas consequências, e as duas
    // importam para a C4:
    //   · asserir a QUERY implica asserir o corpo — é a asserção mais forte, e
    //     é por isso que o canário no corpo não acrescenta nada AQUI;
    //   · coluna clínica nova em `job_postings` (que entra pelo `jp.*`) sai
    //     para o cliente sem ninguém decidir. Isso é a C4, não a C1.
    // A fixture abaixo é REALISTA: só tem o que a query de hoje traz.
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'jp-1', vacancy_number: 42, schedule: null,
        patient_first_name: 'Paciente', dependency_level: 'ALTA',
        encuadres: null, publications: null,
        service_type: null, required_professions: null, social_short_links: null,
      }],
    });

    const [req, res] = reqRes({ id: 'jp-1' });
    await new VacanciesController().getVacancyById(req, res);

    esperaSemVazamentoClinico((res.json as jest.Mock).mock.calls[0][0]);
    expect(sqlDeTodasAsQueries()).not.toMatch(VOCABULARIO_CLINICO);
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
