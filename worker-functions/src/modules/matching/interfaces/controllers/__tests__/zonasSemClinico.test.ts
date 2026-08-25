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

const DIAGNOSTICO = 'Esclerose múltipla, surto-remissão';
const NOME_PACIENTE = 'Rosario';

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
    expect(sql).not.toMatch(/\bdiagnosis\b/);
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(200);
  });

  it('🔴 nenhuma query pede o nome do paciente', async () => {
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const sql = sqlDeTodasAsQueries();
    expect(sql).not.toMatch(/p\.first_name/);
    expect(sql).not.toMatch(/patient_name/);
  });

  it('a rota continua servindo o que ela existe para servir — zona e contagem', async () => {
    // Controle POSITIVO: sem isto, apagar a query inteira também passaria nos
    // dois casos acima. A rota tem de continuar respondendo o agregado.
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const sql = sqlDeTodasAsQueries();
    expect(sql).toMatch(/zone_neighborhood/);
    expect(sql).toMatch(/case_count/);

    const corpo = (res.json as jest.Mock).mock.calls[0][0];
    expect(corpo.success).toBe(true);
    expect(corpo.data.totalCases).toBe(3);
    expect(corpo.data.zones[0]).toMatchObject({ zone: 'Palermo', caseCount: 2, activeCount: 1 });
    expect(corpo.data.identifiedZones).toBe(1);
  });

  it('o caso ainda carrega o que a tela de zonas precisa — número, título e status', async () => {
    const [req, res] = reqRes();

    await new RecruitmentAnalyticsController().getZoneAnalysis(req, res);

    const sql = sqlDeTodasAsQueries();
    expect(sql).toMatch(/'case_number', case_number/);
    expect(sql).toMatch(/'task_name', title/);
    expect(sql).toMatch(/'status', status/);
  });
});
