/**
 * L10 — `GET /api/admin/recruitment/zones` não busca diagnóstico nem nome do
 * paciente.
 *
 * A rota devolvia, num `json_build_object` por caso, `diagnosis` E
 * `patient_name`, para TODOS os casos de uma vez. Medido em produção antes do
 * conserto: 376 casos numa request, 339 com diagnóstico, 336 pacientes
 * distintos. O guard da rota é `requireStaff` + `recruitment:read` — e com o
 * engine desligado o `perm.require` é no-op, então o portão real era só "ser
 * staff".
 *
 * Nenhum consumidor lia esses campos: `useZoneAnalysis` no front tem ZERO
 * callers reais (só o próprio teste o importa) e a tela mostra `comingSoon`.
 * Por isso os dois campos foram TIRADOS do `SELECT`, não movidos para trás de
 * outra célula — não existe célula clínica no catálogo, e inventar uma seria a
 * mesma remoção com mais superfície (o mesmo raciocínio do C1).
 *
 * ⚠️ A guarda é sobre a QUERY, não sobre a resposta (D182 / D170: a fronteira,
 * não o campo lembrado). "A resposta não tem `diagnosis`" ficaria VERDE com o
 * `SELECT` intacto e um `delete` no fim do handler — e aí o texto clínico teria
 * vindo do banco, existido em memória e podido cair num log de erro de query. O
 * que se exige é que ele **não seja buscado**.
 *
 * ⚠️ A fixture carrega o dado proibido DE PROPÓSITO: guarda com fixture limpa
 * não prova nada, porque `not.toContain` passa sobre o que nunca esteve lá.
 *
 * 📌 IRMÃO: `diagnosticoForaDaVaga.test.ts` (C1, chega com o #253) guarda as
 * outras duas rotas — `GET /vacancies/:id` e `GET /recruitment/case/:n`. Ele
 * NÃO alcança esta rota; o próprio commit do C1 registra o buraco. Quando as
 * duas branches estiverem na `stage`, unificar os dois arquivos num só: guarda
 * por rota espalhada é como o defeito clínico já reincidiu 3×.
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
import { RecruitmentAnalyticsController } from '../RecruitmentAnalyticsController';
import { TEXTO_CLINICO } from '@modules/matching/__tests__/guardaVazamentoClinico';

/**
 * O canário é o da GUARDA COMPARTILHADA, não um meu (B3 do gate `revisao-pr`).
 *
 * `guardaVazamentoClinico.ts` existe porque este defeito reincidiu TRÊS vezes,
 * cada guarda procurando a palavra que o autor dela lembrou. Eu tinha
 * reinventado uma quarta, mais fraca — a minha regex era `/\bdiagnosis\b/`, a
 * da casa é `/diagnosis|diagnostico|patholog|patolog/i`. Vocabulário por autor é
 * exatamente o mecanismo da reincidência.
 */
const DIAGNOSTICO = TEXTO_CLINICO;
const NOME_PACIENTE = 'Rosario';

/** A régua clínica da casa, aplicada à query REAL capturada no dublê. */
const VOCABULARIO_CLINICO = /diagnosis|diagnostico|patholog|patolog/i;

function reqRes(): [Request, Response] {
  const req = { params: {}, body: {}, query: {} } as unknown as Request;
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

/**
 * Só a PROJEÇÃO — o trecho entre `SELECT` e `FROM`.
 *
 * ⚠️ Isto existe por causa de uma falha do próprio verificador, achada por
 * sabotagem: o controle positivo casava `zone_neighborhood` em QUALQUER lugar
 * da query, e a string sobrevive no `GROUP BY` mesmo com a projeção destruída.
 * Sabotar o `SELECT` para `'Sin Zona' as zone, COUNT(*) as contagem_qualquer`
 * deixava os 4 casos VERDES. Régua de forma não mede substância: para afirmar
 * "a rota continua servindo o que serve", a asserção tem de olhar a projeção,
 * não o texto inteiro.
 *
 * O caminho contrário — a asserção de vazamento — continua sobre a query
 * INTEIRA, e de propósito: a coluna proibida não pode aparecer em lugar nenhum,
 * nem num `WHERE`, nem num `JOIN`.
 */
/**
 * O SQL SEM os comentários `--`.
 *
 * ⚠️ D182, e eu caí nela escrevendo esta própria guarda: comentário viaja
 * DENTRO da string da query. O comentário que explica por que `case_number`
 * precisa de `jp.` soletra `case_number`, e a asserção de ambiguidade reprovava
 * o código certo por causa da explicação dele. Régua que lê comentário mede
 * prosa, não código.
 */
function sqlSemComentarios(): string {
  return sqlDeTodasAsQueries().replace(/--[^\n]*/g, '');
}

function projecaoDaQuery(): string {
  const sql = sqlDeTodasAsQueries();
  const m = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(sql);
  if (!m) throw new Error('nenhuma query com projeção — a rota deixou de consultar o banco');
  return m[1];
}

describe('L10 — a análise de zonas não busca dado clínico nem nome de paciente', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({
      rows: [
        {
          zone: 'Palermo',
          case_count: '2',
          active_count: '1',
          // O banco DEVOLVERIA isto se o SELECT pedisse. A fixture carrega o
          // dado proibido para que a asserção tenha o que reprovar.
          cases: [
            { case_number: 'C-1', task_name: 'Caso 1', status: 'SEARCHING', diagnosis: DIAGNOSTICO, patient_name: NOME_PACIENTE },
          ],
        },
        { zone: 'Sin Zona', case_count: '1', active_count: '0', cases: [] },
      ],
    });
  });

  it('🔴 nenhuma query pede `p.diagnosis` — por esse nem por outro nome', async () => {
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const sql = sqlDeTodasAsQueries();
    expect(sql).not.toMatch(/p\.diagnosis/);
    // A régua LARGA da casa, não a estreita que eu tinha escrito: `patologia`,
    // `pathology` e `diagnostico` também reprovam.
    expect(sql).not.toMatch(VOCABULARIO_CLINICO);
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(200);
  });

  it('🔴 nenhuma query pede o nome do paciente', async () => {
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const sql = sqlDeTodasAsQueries();
    expect(sql).not.toMatch(/p\.first_name/);
    expect(sql).not.toMatch(/patient_name/);
  });

  /**
   * 🔴 ALLOW-LIST — e é ela que faz esta guarda valer alguma coisa.
   *
   * As duas asserções acima são DENY-LIST de nome de coluna, e deny-list não
   * alcança projeção que não NOMEIA coluna. Medido, não suposto: com
   * `json_build_object(…)::jsonb || to_jsonb(p)` os quatro casos deste arquivo
   * ficavam VERDES enquanto a linha inteira de `patients` — `diagnosis`,
   * `first_name` e `additional_comments` (o texto livre que o front rotula
   * `diagnosisCard.details`) — atravessava para o cliente, porque o controller
   * repassa `cases: row.cases` verbatim.
   *
   * Invertido o sentido: em vez de listar o proibido, esta afirma o CONJUNTO
   * EXATO de colunas de `patients` que a rota tem direito de tocar. Coluna nova
   * de `p` no `SELECT` reprova por padrão — que é o mesmo princípio do
   * `projectWorkerFields` (campo novo nasce FORA de todos os ramos, e portanto
   * invisível).
   */
  it('🔴 a rota toca EXATAMENTE duas colunas de `patients`, e nenhuma projeção anônima', async () => {
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const sql = sqlDeTodasAsQueries();

    // 1. projeção que não nomeia coluna é proibida — é o buraco da deny-list.
    expect(sql).not.toMatch(/to_jsonb|to_json\s*\(|row_to_json|\bp\.\*|\bjp\.\*|SELECT\s+\*/i);

    // 2. o conjunto exato: `zone_neighborhood` (a razão de ser da rota, no
    //    SELECT e no GROUP BY) e `id` (a condição do JOIN). Nada mais.
    const colunasDeP = [...sql.matchAll(/\bp\.([a-z_]+)/gi)].map((m) => m[1]);
    expect(new Set(colunasDeP)).toEqual(new Set(['zone_neighborhood', 'id']));
  });

  it('a rota continua servindo o que ela existe para servir — zona e contagem', async () => {
    // Controle POSITIVO: sem isto, apagar a query inteira também passaria nos
    // dois casos acima. A rota tem de continuar respondendo o agregado.
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const projecao = projecaoDaQuery();
    expect(projecao).toMatch(/COALESCE\(p\.zone_neighborhood, 'Sin Zona'\) as zone/);
    expect(projecao).toMatch(/COUNT\(\*\) as case_count/);
    expect(projecao).toMatch(/as active_count/);

    const corpo = (res.json as jest.Mock).mock.calls[0][0];
    expect(corpo.success).toBe(true);
    expect(corpo.data.totalCases).toBe(3);
    expect(corpo.data.zones[0]).toMatchObject({ zone: 'Palermo', caseCount: 2, activeCount: 1 });
    expect(corpo.data.identifiedZones).toBe(1);
  });

  it('sem nenhuma linha `Sin Zona`, o total de sem-zona é 0 e não NaN', async () => {
    // Ramo `…?.case_count || 0` (l.241): sem este caso, o fallback nunca roda e
    // um `nullPercentage` NaN chegaria à tela sem nada acusar.
    mockQuery.mockResolvedValue({
      rows: [{ zone: 'Palermo', case_count: '2', active_count: '1', cases: [] }],
    });
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const corpo = (res.json as jest.Mock).mock.calls[0][0];
    expect(corpo.data.nullCount).toBe(0);
    expect(corpo.data.nullPercentage).toBe('0.0');
    expect(corpo.data.identifiedZones).toBe(1);
  });

  it('o caso ainda carrega o que a tela de zonas precisa — número, título e status', async () => {
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const projecao = projecaoDaQuery();
    expect(projecao).toMatch(/'case_number', jp\.case_number/);
    expect(projecao).toMatch(/'task_name', jp\.title/);
    expect(projecao).toMatch(/'status', jp\.status/);
  });

  /**
   * 🔴 A qualificação `jp.` é CONTRATO, não estilo.
   *
   * `case_number` e `status` existem em `job_postings` E em `patients`. Sem
   * qualificar, o Postgres levanta `column reference is ambiguous` e a rota
   * inteira responde 500 — que é como ela esteve em PRODUÇÃO por tempo
   * indeterminado, e o motivo de ninguém no front consumi-la. Nenhum teste
   * unit podia ver isso: com dublê de banco a query nunca executa. Quem achou
   * foi o e2e (`zonas-sem-clinico.e2e.test.ts`), e este caso é a rede barata
   * que impede a reincidência sem precisar do banco.
   */
  it('🔴 nenhuma coluna ambígua fica sem qualificar — `case_number` e `status` existem nas DUAS tabelas', async () => {
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const sql = sqlSemComentarios();
    // Referência CRUA: não precedida de ponto (qualificada) nem de aspa (é a
    // chave literal do `json_build_object`, não uma coluna).
    expect(sql).not.toMatch(/(?<![.\w'])case_number\b/);
    expect(sql).not.toMatch(/(?<![.\w'])status\b/);
  });
});
