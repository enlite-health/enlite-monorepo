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
 * provam — que produção responde. Aqui o objeto sob teste é o próprio helper que
 * JULGA pass/fail, e o que precisa ser encenado é a FALHA DO GOOGLE, que não se
 * encomenda. Nenhum teste de produção passou a usar stub.
 */
import { test, expect } from '@playwright/test';
import { queryLogs, waitForLog, payloadString } from './cloudLogging';

type Reply =
  | { status: number; body?: unknown }
  | { networkError: string }
  | { thrown: unknown }; // erro que NÃO é Error — cobre o `String(err)`

const LOGGING_HOST = 'logging.googleapis.com';

const realFetch = globalThis.fetch;
const realKService = process.env.K_SERVICE;

interface Stub {
  /** Quantas chamadas ao endpoint de logging aconteceram. */
  calls: () => number;
  /** URLs vistas (para assertar FORA do stub — ver nota abaixo). */
  urls: () => string[];
  /** Corpos enviados, já desserializados. */
  bodies: () => Array<Record<string, unknown>>;
}

/**
 * Instala um `fetch` que serve o token e depois consome `replies` em ordem.
 *
 * Nota deliberada: este stub NÃO faz `expect`. Um `expect` que falhasse aqui
 * dentro lançaria DENTRO do `fetch`, e o helper classificaria como erro de rede —
 * repetindo 4× e escondendo a causa real atrás de "falhou em 4 tentativas".
 * O stub só REGISTRA; quem afirma é o teste, depois.
 */
function stubFetch(replies: Reply[]): Stub {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes('metadata.google.internal')) {
      return new Response(JSON.stringify({ access_token: 'token-de-teste' }), { status: 200 });
    }

    urls.push(url);
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);

    const reply = replies[urls.length - 1];
    if (!reply) throw new Error(`stub sem resposta programada para a chamada ${urls.length}`);
    if ('networkError' in reply) throw new Error(reply.networkError);
    if ('thrown' in reply) throw reply.thrown;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch;

  return { calls: () => urls.length, urls: () => [...urls], bodies: () => [...bodies] };
}

const PARAMS = { message: 'admission.notifier.confirmation.send_failed', withinMinutes: 60 };
const ENTRY = { timestamp: '2026-08-17T06:00:00Z', jsonPayload: { appointmentId: 'appt-1' } };

test.beforeEach(() => {
  process.env.K_SERVICE = 'spec'; // token via metadata → interceptável pelo stub
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKService === undefined) delete process.env.K_SERVICE;
  else process.env.K_SERVICE = realKService;
});

// ---------------------------------------------------------------- transitórios

test('500 transitório: repete e devolve as entradas em vez de derrubar o teste', async () => {
  const stub = stubFetch([
    { status: 500, body: { error: { status: 'INTERNAL' } } },
    { status: 500, body: { error: { status: 'INTERNAL' } } },
    { status: 200, body: { entries: [ENTRY] } },
  ]);

  const entries = await queryLogs(PARAMS);

  expect(entries).toHaveLength(1);
  expect(entries[0]?.jsonPayload?.appointmentId).toBe('appt-1');
  expect(stub.calls(), 'deveria ter repetido até o 200').toBe(3);
  expect(stub.urls().every((u) => u.includes(LOGGING_HOST))).toBe(true);
});

test('erro de rede também é transitório: repete e recupera', async () => {
  const stub = stubFetch([
    { networkError: 'socket hang up' },
    { status: 200, body: { entries: [] } },
  ]);

  await expect(queryLogs(PARAMS)).resolves.toEqual([]);
  expect(stub.calls()).toBe(2);
});

// ------------------------------------------------------------ falha ruidosa

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

test('rejeição que não é Error ainda vira mensagem legível (não "[object Object]")', async () => {
  // `fetch` pode rejeitar com coisa que não é Error (undici já fez isso). O helper
  // usa String(err) nesse caso; sem isso o relatório sai ilegível.
  const stub = stubFetch(Array.from({ length: 8 }, () => ({ thrown: 'boom-nao-error' })));

  await expect(queryLogs(PARAMS)).rejects.toThrow(/rede: boom-nao-error/);
  expect(stub.calls()).toBe(4);
});

// ------------------------------------------------------- não-retriáveis

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

// ------------------------------------------------------------------ contrato

test('200 sem entries continua devolvendo lista vazia (contrato preservado)', async () => {
  const stub = stubFetch([{ status: 200, body: {} }]);

  await expect(queryLogs(PARAMS)).resolves.toEqual([]);
  expect(stub.calls()).toBe(1);
  expect(stub.bodies()[0]?.pageSize, 'sem `limit` explícito o default é 20').toBe(20);
});

test('o filtro enviado ao Google carrega `match` e o `limit` pedido', async () => {
  const stub = stubFetch([{ status: 200, body: { entries: [] } }]);

  await queryLogs({ ...PARAMS, match: { patientId: 'pac-42' }, limit: 3 });

  const [body] = stub.bodies();
  expect(body?.pageSize).toBe(3);
  const filtro = String(body?.filter);
  expect(filtro).toContain(`jsonPayload.message="${PARAMS.message}"`);
  expect(filtro, '`match` precisa virar igualdade no jsonPayload').toContain(
    'jsonPayload.patientId="pac-42"',
  );
  expect(filtro).toContain('resource.type="cloud_run_revision"');
});

test('projeto e serviço vêm do ambiente, com default quando a var não existe', async () => {
  const realProject = process.env.GCP_PROJECT_ID;
  const realService = process.env.LOG_SERVICE_NAME;
  try {
    // (a) vars setadas → o valor do ambiente manda
    process.env.GCP_PROJECT_ID = 'projeto-do-ambiente';
    process.env.LOG_SERVICE_NAME = 'servico-do-ambiente';
    const comEnv = stubFetch([{ status: 200, body: { entries: [] } }]);
    await queryLogs(PARAMS);
    expect(comEnv.bodies()[0]?.resourceNames).toEqual(['projects/projeto-do-ambiente']);
    expect(String(comEnv.bodies()[0]?.filter)).toContain(
      'resource.labels.service_name="servico-do-ambiente"',
    );

    // (b) vars ausentes → cai nos defaults de produção
    delete process.env.GCP_PROJECT_ID;
    delete process.env.LOG_SERVICE_NAME;
    const semEnv = stubFetch([{ status: 200, body: { entries: [] } }]);
    await queryLogs(PARAMS);
    expect(semEnv.bodies()[0]?.resourceNames).toEqual(['projects/enlite-prd']);
    expect(String(semEnv.bodies()[0]?.filter)).toContain(
      'resource.labels.service_name="worker-functions"',
    );
  } finally {
    if (realProject === undefined) delete process.env.GCP_PROJECT_ID;
    else process.env.GCP_PROJECT_ID = realProject;
    if (realService === undefined) delete process.env.LOG_SERVICE_NAME;
    else process.env.LOG_SERVICE_NAME = realService;
  }
});

// ------------------------------------------------------------- waitForLog

test('waitForLog devolve a entrada assim que ela aparece', async () => {
  const stub = stubFetch([{ status: 200, body: { entries: [ENTRY] } }]);

  const entry = await waitForLog(PARAMS);

  expect(entry?.timestamp).toBe(ENTRY.timestamp);
  expect(stub.calls()).toBe(1);
  expect(stub.bodies()[0]?.pageSize, 'waitForLog pede 1 por vez').toBe(1);
});

test('waitForLog faz polling: vazio na 1ª volta, entrada na 2ª', async () => {
  const stub = stubFetch([
    { status: 200, body: { entries: [] } },
    { status: 200, body: { entries: [ENTRY] } },
  ]);

  const entry = await waitForLog(PARAMS, { timeoutMs: 5_000, intervalMs: 1 });

  expect(entry?.timestamp).toBe(ENTRY.timestamp);
  expect(stub.calls()).toBe(2);
});

test('waitForLog devolve null quando estoura o prazo (mensagem fica com o caller)', async () => {
  const stub = stubFetch([{ status: 200, body: { entries: [] } }]);

  await expect(waitForLog(PARAMS, { timeoutMs: 0 })).resolves.toBeNull();
  expect(stub.calls()).toBe(1);
});

test('waitForLog não devolve `undefined` se o Google mandar entries malformado', async () => {
  // Defensivo de verdade: `entries: [null]` tem length 1 e passaria o guard, mas
  // `entries[0]` é null — o caller espera `LogEntry | null`, nunca undefined.
  const stub = stubFetch([{ status: 200, body: { entries: [null] } }]);

  await expect(waitForLog(PARAMS, { timeoutMs: 0 })).resolves.toBeNull();
  expect(stub.calls()).toBe(1);
});

// ---------------------------------------------------------- payloadString

test('payloadString lê campo string e recusa o resto', () => {
  const entry = {
    timestamp: 'agora',
    jsonPayload: { externalId: 'MM123', appointmentId: 42, nulo: null },
  };

  expect(payloadString(entry, 'externalId')).toBe('MM123');
  expect(payloadString(entry, 'appointmentId'), 'número não é string → null').toBeNull();
  expect(payloadString(entry, 'nulo')).toBeNull();
  expect(payloadString(entry, 'inexistente')).toBeNull();
  expect(payloadString({ timestamp: 'agora' }, 'externalId'), 'sem jsonPayload').toBeNull();
  expect(payloadString(null, 'externalId'), 'sem entry').toBeNull();
});
