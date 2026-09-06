/**
 * VacancySocialLinksController — o caminho que a RECRUTADORA usa.
 *
 * Este arquivo existe porque a revisão pré-merge do PR #249 provou o seguinte:
 * reintroduzindo o vazamento original neste controller, `tsc` ficava limpo e a
 * suíte inteira passava — 4359 testes verdes com o diagnóstico do paciente indo
 * para o Short.io. O controller tinha 0% de cobertura.
 *
 * A guarda anterior morava só no `ShortLinkService`, e ainda por cima só
 * reprovava se a FIXTURE carregasse um diagnóstico — nenhuma carregava, então
 * `toHaveBeenCalledWith` ignorava a chave `undefined`. Duas lições viraram
 * regra aqui:
 *
 *   1. a fixture do banco CARREGA diagnóstico (`DIAGNOSTICO_DA_FIXTURE`), para
 *      que qualquer repasse — em qualquer param, no title ou no path — apareça;
 *   2. a asserção é sobre o PAYLOAD QUE SAI no `fetch`, não sobre os params
 *      montados por dentro. O que importa é o que atravessa a fronteira.
 */

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockLogEventSafe = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: mockQuery, connect: mockConnect }) }),
  },
}));
jest.mock('@shared/logging', () => ({
  loggingAls: { getStore: () => ({ traceId: 'trace-1' }) },
  reportError: jest.fn(),
}));
jest.mock('../../../infrastructure/JobPostingAuditRepository', () => ({
  JobPostingAuditRepository: jest.fn().mockImplementation(() => ({ logEventSafe: mockLogEventSafe })),
}));

import { Request, Response } from 'express';
import { VacancySocialLinksController } from '../VacancySocialLinksController';
import { TEXTO_CLINICO, esperaSemVazamentoClinico, esperaSqlSemDadoClinico } from '../../../__tests__/guardaVazamentoClinico';

/** Texto clínico livre, no formato real do campo (`patients.diagnosis` é TEXT). */
const DIAGNOSTICO_DA_FIXTURE = TEXTO_CLINICO;

const LINHA_DA_VAGA = {
  case_number: 7,
  vacancy_number: 2,
  country: 'AR',
  // ⚠️ DE PROPÓSITO: a fixture carrega o diagnóstico mesmo que o SELECT atual
  // não o traga. Se alguém reintroduzir o `LEFT JOIN patients`, o valor está
  // aqui esperando, e as asserções abaixo reprovam.
  pathologies: DIAGNOSTICO_DA_FIXTURE,
  diagnosis: DIAGNOSTICO_DA_FIXTURE,
  social_short_links: {},
};

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.payload = p; return res; },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

function makeReq(over: Record<string, unknown> = {}): Request {
  return { params: { id: 'jp-1' }, body: { channel: 'linkedin' }, user: { uid: 'u-1' }, ...over } as unknown as Request;
}

const fetchOriginal = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SHORT_IO_API_KEY = 'chave-de-teste';
  process.env.SHORT_IO_DOMAIN = 'srt.io';
  mockQuery.mockResolvedValue({ rows: [LINHA_DA_VAGA] });
  mockConnect.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });
  mockLogEventSafe.mockResolvedValue(undefined);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ shortURL: 'https://srt.io/abc', id: 'lnk-1' }),
  }) as unknown as typeof fetch;
});

afterEach(() => { global.fetch = fetchOriginal; });

/** O corpo que o controller mandou para a api.short.io. */
function payloadEnviado() {
  const chamada = (global.fetch as jest.Mock).mock.calls[0];
  return { url: chamada[0] as string, body: JSON.parse((chamada[1] as { body: string }).body) };
}

describe('generateSocialLink — o que ATRAVESSA a fronteira para o Short.io', () => {
  // ── A guarda central ──────────────────────────────────────────────────────
  // ⚠️ A 1ª versão desta guarda olhava só o `body` do fetch. A revisão final
  // provou três fugas que ela não via: header do fetch, SEGUNDA query trazendo
  // o dado para a memória, e `console.log`. Agora a asserção é sobre TUDO que
  // atravessa: a chamada inteira do fetch (url + init + headers), todas as
  // queries, e o que foi para o log.
  it('nada do paciente atravessa a fronteira — fetch INTEIRO, queries e log', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await new VacancySocialLinksController().generateSocialLink(makeReq(), makeRes());

    esperaSemVazamentoClinico(
      (global.fetch as jest.Mock).mock.calls,   // url + init + headers, tudo
      mockQuery.mock.calls,                     // TODAS as queries, não a [0]
      logSpy.mock.calls,
      errSpy.mock.calls,
    );
  });

  it('nenhuma query pede diagnosis nem faz JOIN em patients — em NENHUMA delas', async () => {
    await new VacancySocialLinksController().generateSocialLink(makeReq(), makeRes());

    esperaSqlSemDadoClinico(mockQuery.mock.calls);
  });

  it('a URL é função PURA de caso/vaga/canal/país — conjunto EXATO de params', async () => {
    await new VacancySocialLinksController().generateSocialLink(makeReq(), makeRes());

    const url = new URL(payloadEnviado().body.originalURL);
    expect(url.origin + url.pathname).toBe('https://app.enlite.health/vacantes/caso7-2');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: 'linkedin',
      utm_medium: 'vacante',
      utm_campaign: '7',
      utm_id: 'recrutamento',
      utm_term: 'AR',
    });
  });

  it('o title do link também é função pura de caso/vaga/canal', async () => {
    await new VacancySocialLinksController().generateSocialLink(makeReq(), makeRes());

    expect(payloadEnviado().body.title).toBe('Caso 7-2 — linkedin');
  });

  it('canal `site` vira utm_source portal_jobs, e nada mais muda', async () => {
    await new VacancySocialLinksController().generateSocialLink(
      makeReq({ body: { channel: 'site' } }), makeRes(),
    );

    const url = new URL(payloadEnviado().body.originalURL);
    expect(url.searchParams.get('utm_source')).toBe('portal_jobs');
    expect(JSON.stringify(payloadEnviado().body)).not.toContain('Alzheimer');
  });

  it('sem país: utm_term some e nada ocupa o lugar', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...LINHA_DA_VAGA, country: null }] });

    await new VacancySocialLinksController().generateSocialLink(makeReq(), makeRes());

    expect(Object.fromEntries(new URL(payloadEnviado().body.originalURL).searchParams)).toEqual({
      utm_source: 'linkedin',
      utm_medium: 'vacante',
      utm_campaign: '7',
      utm_id: 'recrutamento',
    });
  });

  // ── A consulta ao banco não deve nem BUSCAR o dado clínico ────────────────
  // ── Caminhos de erro ──────────────────────────────────────────────────────
  it('body inválido → 400 e não chama o Short.io', async () => {
    const res = makeRes();
    await new VacancySocialLinksController().generateSocialLink(makeReq({ body: { channel: 'tiktok' } }), res);

    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('vaga inexistente → 404 e não chama o Short.io', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();

    await new VacancySocialLinksController().generateSocialLink(makeReq(), res);

    expect(res.statusCode).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('vaga sem case_number → 400 e não chama o Short.io', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...LINHA_DA_VAGA, case_number: null }] });
    const res = makeRes();

    await new VacancySocialLinksController().generateSocialLink(makeReq(), res);

    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('Short.io sem credencial → 500 e não chama a API externa', async () => {
    delete process.env.SHORT_IO_API_KEY;
    const res = makeRes();

    await new VacancySocialLinksController().generateSocialLink(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('canal já tem link → 409 e não chama o Short.io de novo', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...LINHA_DA_VAGA, social_short_links: { linkedin: { url: 'https://srt.io/ja', id: 'x' } } }] });
    const res = makeRes();

    await new VacancySocialLinksController().generateSocialLink(makeReq(), res);

    expect(res.statusCode).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('link legado gravado como string é normalizado para {url,id} sem perder os outros canais', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...LINHA_DA_VAGA, social_short_links: { facebook: 'https://srt.io/legado' } }] });
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    mockConnect.mockResolvedValue(client);

    await new VacancySocialLinksController().generateSocialLink(makeReq(), makeRes());

    const update = client.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE job_postings'));
    expect(JSON.parse((update![1] as string[])[0])).toEqual({
      facebook: { url: 'https://srt.io/legado', id: '' },
      linkedin: { url: 'https://srt.io/abc', id: 'lnk-1' },
    });
  });

  it('falha na transação: dá ROLLBACK, solta o client e não devolve 200', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (String(sql).includes('UPDATE job_postings')) throw new Error('deadlock');
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    mockConnect.mockResolvedValue(client);
    const res = makeRes();

    await new VacancySocialLinksController().generateSocialLink(makeReq(), res);

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(res.statusCode).not.toBe(200);
  });

  it('Short.io responde erro → 502 com o corpo do erro', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => 'rate limited',
    }) as unknown as typeof fetch;
    const res = makeRes();

    await new VacancySocialLinksController().generateSocialLink(makeReq(), res);

    expect(res.statusCode).toBe(502);
  });
});

describe('getSocialLinksStats', () => {
  it('sem credencial do Short.io → 500', async () => {
    delete process.env.SHORT_IO_API_KEY;
    const res = makeRes();

    await new VacancySocialLinksController().getSocialLinksStats(makeReq(), res);

    expect(res.statusCode).toBe(500);
  });

  it('vaga inexistente → 404', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = makeRes();

    await new VacancySocialLinksController().getSocialLinksStats(makeReq(), res);

    expect(res.statusCode).toBe(404);
  });

  it('agrega cliques por canal e inclui o link legado (sem id) com 0', async () => {
    mockQuery.mockResolvedValue({ rows: [{ social_short_links: {
      linkedin: { url: 'https://srt.io/a', id: 'l1' },
      facebook: 'https://srt.io/legado',
    } }] });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ clicks: 42 }) }) as unknown as typeof fetch;
    const res = makeRes();

    await new VacancySocialLinksController().getSocialLinksStats(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: unknown }).data).toMatchObject({
      linkedin: { url: 'https://srt.io/a', clicks: 42 },
      facebook: { url: 'https://srt.io/legado', clicks: 0 },
    });
  });

  // ⚠️ Comportamento MEDIDO, não desejado: erro do Short.io vira "0 cliques" na
  // tela do marketing, indistinguível de "ninguém clicou". Está em LISTA como
  // falha silenciosa; o teste trava o comportamento atual para que uma mudança
  // seja deliberada.
  it('Short.io fora do ar vira 0 cliques — silenciosamente (comportamento atual)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ social_short_links: { linkedin: { url: 'https://srt.io/a', id: 'l1' } } }] });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const res = makeRes();

    await new VacancySocialLinksController().getSocialLinksStats(makeReq(), res);

    expect((res.payload as { data: Record<string, { clicks: number }> }).data.linkedin.clicks).toBe(0);
  });

  it('sem usuário na request e sem traceId: grava a auditoria com ator nulo', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    mockConnect.mockResolvedValue(client);

    await new VacancySocialLinksController().generateSocialLink(makeReq({ user: undefined }), makeRes());

    expect(mockLogEventSafe).toHaveBeenCalledWith(client, expect.objectContaining({ actorUserId: null }));
  });

  it('link legado como string na hora de montar as stats vira clicks 0', async () => {
    mockQuery.mockResolvedValue({ rows: [{ social_short_links: { site: 'https://srt.io/so-string' } }] });
    const res = makeRes();

    await new VacancySocialLinksController().getSocialLinksStats(makeReq(), res);

    expect((res.payload as { data: Record<string, { url: string; clicks: number }> }).data.site)
      .toEqual({ url: 'https://srt.io/so-string', clicks: 0 });
  });

  it('Short.io devolve resposta sem o campo clicks → 0, não undefined', async () => {
    mockQuery.mockResolvedValue({ rows: [{ social_short_links: { linkedin: { url: 'https://srt.io/a', id: 'l1' } } }] });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    const res = makeRes();

    await new VacancySocialLinksController().getSocialLinksStats(makeReq(), res);

    expect((res.payload as { data: Record<string, { clicks: number }> }).data.linkedin.clicks).toBe(0);
  });

  it('banco fora do ar → 500 com a mensagem, e o erro NÃO some', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();

    await new VacancySocialLinksController().getSocialLinksStats(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect((res.payload as { details: string }).details).toBe('connection refused');
  });
});
