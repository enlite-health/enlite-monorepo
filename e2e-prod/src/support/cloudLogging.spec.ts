/**
 * cloudLogging.spec.ts — o helper de leitura de log aguenta blip do Google?
 *
 * Por que existe: em 2026-08-17 o monitor ficou vermelho duas vezes seguidas, em
 * testes DIFERENTES, com o mesmo erro — `Cloud Logging 500: Internal error
 * encountered`. Não era regressão de produto: entre 06:00 e 06:10 UTC, 6 de 15
 * chamadas a `logging.googleapis.com` voltaram 500 (medido nas métricas do próprio
 * Google) e o helper lançava no primeiro não-ok, sem repetir.
 *
 * Estes testes travam as DUAS metades da política, que puxam para lados opostos:
 *   • transitório (5xx/rede) → repete e sobrevive;
 *   • esgotou / não-retriável → LANÇA. Nunca `[]`, porque os testes que consomem
 *     isto afirmam "zero falhas" e lista vazia por erro de leitura seria verde falso.
 *
 * Hermético: nada de rede. `K_SERVICE` faz o accessToken() ir pelo caminho de
 * metadata (que é `fetch`), então o stub cobre token e consulta.
 *
 * E o "PROIBIDO mock" do playwright.config? Vale para os projetos que SÃO o
 * monitor (smoke/regression/admin): lá, mockar destruiria a única coisa que eles
 * provam — que produção responde. Aqui o objeto sob teste é o próprio helper, e o
 * que precisa ser encenado é a FALHA DO GOOGLE, que não se encomenda. Nenhum teste
 * de produção passou a usar stub.
 */
import { test, expect } from '@playwright/test';
import { queryLogs } from './cloudLogging';

type Reply = { status: number; body?: unknown } | { networkError: string };

const LOGGING_HOST = 'logging.googleapis.com';

const realFetch = globalThis.fetch;
const realKService = process.env.K_SERVICE;

/** Instala um `fetch` que serve o token e depois consome `replies` em ordem. */
function stubFetch(replies: Reply[]): { calls: () => number } {
  let calls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes('metadata.google.internal')) {
      return new Response(JSON.stringify({ access_token: 'token-de-teste' }), { status: 200 });
    }

    expect(url, 'o helper só deve falar com o endpoint de logging').toContain(LOGGING_HOST);
    const reply = replies[calls];
    calls += 1;
    if (!reply) throw new Error(`stub sem resposta programada para a chamada ${calls}`);
    if ('networkError' in reply) throw new Error(reply.networkError);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch;

  return { calls: () => calls };
}

const PARAMS = { message: 'admission.notifier.confirmation.send_failed', withinMinutes: 60 };

test.beforeEach(() => {
  process.env.K_SERVICE = 'spec'; // token via metadata → interceptável pelo stub
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKService === undefined) delete process.env.K_SERVICE;
  else process.env.K_SERVICE = realKService;
});

test('500 transitório: repete e devolve as entradas em vez de derrubar o teste', async () => {
  const entry = { timestamp: '2026-08-17T06:00:00Z', jsonPayload: { appointmentId: 'appt-1' } };
  const stub = stubFetch([
    { status: 500, body: { error: { status: 'INTERNAL' } } },
    { status: 500, body: { error: { status: 'INTERNAL' } } },
    { status: 200, body: { entries: [entry] } },
  ]);

  const entries = await queryLogs(PARAMS);

  expect(entries).toHaveLength(1);
  expect(entries[0]?.jsonPayload?.appointmentId).toBe('appt-1');
  expect(stub.calls(), 'deveria ter repetido até o 200').toBe(3);
});

test('erro de rede também é transitório: repete e recupera', async () => {
  const stub = stubFetch([
    { networkError: 'socket hang up' },
    { status: 200, body: { entries: [] } },
  ]);

  await expect(queryLogs(PARAMS)).resolves.toEqual([]);
  expect(stub.calls()).toBe(2);
});

test('500 sempre: LANÇA depois de esgotar — nunca devolve lista vazia (verde falso)', async () => {
  const stub = stubFetch(Array.from({ length: 8 }, () => ({ status: 500 as const })));

  // O ponto crítico: quem chama afirma "zero send_failed". Se a leitura falhou e
  // voltasse `[]`, a asserção passaria por AUSÊNCIA DE PROVA.
  await expect(queryLogs(PARAMS)).rejects.toThrow(/falhou em 4 tentativas/);
  expect(stub.calls(), 'exatamente 1 tentativa + 3 repetições').toBe(4);
});

test('rede caída sempre: LANÇA depois de esgotar, também sem lista vazia', async () => {
  const stub = stubFetch(
    Array.from({ length: 8 }, () => ({ networkError: 'ECONNRESET' as const })),
  );

  await expect(queryLogs(PARAMS)).rejects.toThrow(/falhou em 4 tentativas[\s\S]*ECONNRESET/);
  expect(stub.calls()).toBe(4);
});

test('403 não é transitório: lança na primeira e não mascara falta de permissão', async () => {
  const stub = stubFetch([
    { status: 403, body: { error: { message: 'Permission denied on resource project.' } } },
    { status: 200, body: { entries: [] } },
  ]);

  await expect(queryLogs(PARAMS)).rejects.toThrow(/Cloud Logging 403/);
  expect(stub.calls(), '403 não deve ser repetido').toBe(1);
});

test('400 (filtro inválido) falha rápido, sem repetir', async () => {
  const stub = stubFetch([{ status: 400, body: { error: { message: 'Invalid filter.' } } }]);

  await expect(queryLogs(PARAMS)).rejects.toThrow(/Cloud Logging 400/);
  expect(stub.calls()).toBe(1);
});

test('200 sem entries continua devolvendo lista vazia (contrato preservado)', async () => {
  const stub = stubFetch([{ status: 200, body: {} }]);

  await expect(queryLogs(PARAMS)).resolves.toEqual([]);
  expect(stub.calls()).toBe(1);
});
