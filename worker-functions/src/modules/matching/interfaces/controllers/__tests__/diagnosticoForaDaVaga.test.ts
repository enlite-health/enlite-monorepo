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

  /**
   * 🔴 CONTROLE POSITIVO — B6 do gate `revisao-pr`.
   *
   * O gate provou por MUTAÇÃO que esta guarda era inerte: trocando o `SELECT` de
   * `getVacancyById` por `SELECT 1 AS gutado`, os 4 casos ficavam VERDES e os
   * 265 testes de controller também. O motivo é estrutural — as asserções eram
   * todas NEGATIVAS (`not.toMatch`), e o que passava por controle positivo
   * afirmava sobre as LINHAS FIXAS do dublê, que voltam iguais qualquer que
   * seja o SQL. Régua que só sabe dizer "não vi o proibido" dá verde para a
   * query vazia.
   *
   * O comentário acima diz que "asserir a QUERY implica asserir o corpo — é a
   * asserção mais forte". Na direção do vazamento, sim. Na direção de "a rota
   * ainda funciona", é a mais FRACA, e é essa que faltava.
   *
   * ⚠️ E a allow-list de `p.` não é zelo: deny-list de nome de coluna não
   * alcança projeção que não NOMEIA coluna. Medido na rota irmã de zonas —
   * `json_build_object(…)::jsonb || to_jsonb(p)` passava com a guarda verde
   * arrastando `diagnosis` inteiro. Aqui a mesma classe entraria por `p.*`.
   */
  /**
   * ⚠️ O alias `p` está SOBRECARREGADO neste código: no `getCaseAnalysis` a 2ª
   * query usa `p` para `publications` (`p.channel`, `p.recruiter_name`,
   * `p.observations`). Uma allow-list sobre a UNIÃO das queries conflaria duas
   * tabelas e aceitaria coluna de `patients` só porque `publications` tem uma
   * homônima. Por isso o recorte é a query que de fato faz `JOIN patients p`.
   *
   * (O alias duplo é dívida do arquivo, não deste PR — anotado no handoff.)
   */
  const queryDePacientes = (): string => {
    const q = mockQuery.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => /\bpatients\s+p\b/i.test(sql));
    if (!q) throw new Error('nenhuma query faz JOIN patients p — a rota deixou de consultar o paciente');
    return q;
  };

  const colunasDePacientes = (): Set<string> =>
    new Set([...queryDePacientes().matchAll(/\bp\.([a-z_]+)/gi)].map((m) => m[1]));

  it('🔴 GET /vacancies/:id continua trazendo o que a tela precisa, e SÓ colunas nomeadas de `patients`', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'jp-1', encuadres: null, publications: null, social_short_links: null }] });
    const [req, res] = reqRes({ id: 'jp-1' });

    await new VacanciesController().getVacancyById(req, res);
    const sql = queryDePacientes();

    // Positivo: apagar o SELECT reprova aqui.
    expect(sql).toMatch(/p\.first_name as patient_first_name/);
    expect(sql).toMatch(/p\.dependency_level/);
    expect(sql).toMatch(/COALESCE\(pa\.neighborhood, p\.zone_neighborhood\)/);

    // Nenhuma projeção anônima sobre `patients` — a tabela que carrega o clínico.
    expect(sql).not.toMatch(/to_jsonb\s*\(\s*p\b|row_to_json\s*\(\s*p\b|\bp\.\*/i);
    // Conjunto EXATO. Cada membro conferido contra `\\d patients`: `dependency_level`
    // é enum de severidade (SEVERE|VERY_SEVERE|MODERATE|MILD) que o C1 decidiu
    // manter, `service_type` é array de profissão, `insurance_verified` e
    // `city_locality` são operacionais. Nenhuma é texto clínico livre.
    expect(colunasDePacientes()).toEqual(
      new Set(['first_name', 'last_name', 'zone_neighborhood', 'dependency_level', 'id',
               'city_locality', 'insurance_verified', 'service_type']),
    );
  });

  it('🔴 GET /recruitment/case/:n idem — positivo e allow-list de `patients`', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const [req, res] = reqRes({ caseNumber: '442' });

    await new RecruitmentAnalyticsController().getCaseAnalysis(req, res);
    const sql = queryDePacientes();

    expect(sql).toMatch(/p\.first_name as patient_first_name/);
    expect(sql).toMatch(/p\.dependency_level/);
    expect(sql).not.toMatch(/to_jsonb\s*\(\s*p\b|row_to_json\s*\(\s*p\b|\bp\.\*/i);
    // Conjunto MENOR que o do `getVacancyById`, e é assim mesmo: esta rota não
    // pede `service_type`/`insurance_verified`/`city_locality`. Duas rotas, duas
    // allow-lists — uma lista compartilhada aceitaria em uma o que só a outra
    // tem direito de ver.
    expect(colunasDePacientes()).toEqual(
      new Set(['first_name', 'last_name', 'dependency_level', 'zone_neighborhood', 'id']),
    );
  });
});
