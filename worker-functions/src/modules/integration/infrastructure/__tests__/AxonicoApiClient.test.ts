/**
 * AxonicoApiClient.test.ts — F1 da change `integracao-axonico`.
 *
 * REGRA DURA: `fetch` é SEMPRE mockado. Nenhum teste desta suíte chama a API real do Axonico —
 * não existe sandbox, e todo `PUT /api/comprobante` real gera faturamento. Um espião registra
 * toda URL requisitada e o `afterAll` prova zero chamadas a hosts do domínio `axonico.ar`.
 */

// ── Mock do fetch global (padrão do repo — TalentumApiClient.test.ts) ──────
//
// `allRequestedUrls` é um array PLANO, fora do controle do jest — `mockResolvedValueOnce`/
// `mockImplementationOnce` (usados pela maioria dos testes abaixo) consultam a fila de
// implementações ANTES da implementação base do `jest.fn(...)`, então um `push` dentro dessa
// implementação base nunca rodaria para esses testes. Por isso o espião vive num wrapper que
// SEMPRE roda, à frente do `mockFetch` (que continua controlando o retorno de cada teste).
// `jest.clearAllMocks()` no `beforeEach` limpa `mockFetch.mock.calls`/fila, mas não este array —
// de propósito, para o `afterAll` provar zero chamadas reais em TODA a suíte, não só no teste
// corrente.
const allRequestedUrls: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetch: jest.Mock<any, any> = jest.fn(() => {
  throw new Error('unexpected fetch call not mocked');
});
(global as any).fetch = (input: unknown, init?: unknown) => {
  allRequestedUrls.push(String(input));
  return mockFetch(input, init);
};

// Mock do GCP Secret Manager — padrão do repo (ServicePrincipalSecretManagerRepo.test.ts).
const mockAccessSecretVersion = jest.fn();
jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: mockAccessSecretVersion,
  })),
}));

import { AxonicoApiClient } from '../AxonicoApiClient';
import { resolveServiceMapping, AxonicoUnmappedServiceTypeError } from '../AxonicoServiceMapping';
import {
  AxonicoAuthError,
  AxonicoValidationError,
  AxonicoBusinessError,
  AxonicoIndeterminateWriteError,
} from '../AxonicoErrors';

// ── Helpers de resposta ──────────────────────────────────────────

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function loginResponse(overrides: { accessToken?: string; matricula?: string } = {}) {
  return jsonResponse({
    data: {
      accessToken: overrides.accessToken ?? '1|mock-token-abc',
      matricula: overrides.matricula ?? '352722',
    },
  });
}

function pacienteFilterResponse(
  entries: Array<{ historia_clinica: string; coberturas: Array<{ nro_afiliado: string }> }>
) {
  return jsonResponse({ data: entries });
}

function comprobanteFilterResponse(count: number) {
  return jsonResponse({ data: Array.from({ length: count }, (_, i) => ({ id: i })) });
}

function submitResponse(overrides: {
  numero_comprobante?: string;
  cod_autorizacion?: string;
  detalleCodAutorizacion?: string | null;
} = {}) {
  return jsonResponse({
    data: {
      numero_comprobante: overrides.numero_comprobante ?? '1407706',
      cod_autorizacion: overrides.cod_autorizacion ?? '111114077061',
      detalle: [{ cod_autorizacion: overrides.detalleCodAutorizacion ?? null }],
    },
  });
}

const SERVICE_CODES = resolveServiceMapping('AT');

// Instant fixo (D370) — nunca Date.now() ao vivo neste teste.
const FIXED_NOW = new Date('2026-09-18T14:32:00');
const SERVICE_DATE = new Date('2026-09-10T00:00:00');

function makeClient(now: () => Date = () => FIXED_NOW) {
  return new AxonicoApiClient('RIATSRL', 'senha-fake-de-teste', 'http://localhost:9912', now);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Login + cache de token ───────────────────────────────────────

describe('AxonicoApiClient — login e cache de token', () => {
  it('login → token cacheado e reusado na chamada seguinte (sem 2º POST /api/login)', async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(pacienteFilterResponse([]));
    mockFetch.mockResolvedValueOnce(pacienteFilterResponse([]));

    await client.findPatientByDni('30712345');
    await client.findPatientByDni('30712345');

    const loginCalls = mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/login'));
    expect(loginCalls).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 login + 2 findPatientByDni
  });

  it('login sem data.matricula falha explicitamente (nunca cai em constante)', async () => {
    const client = makeClient();
    // Corpo SEM a chave `matricula` de propósito (não usar o helper `loginResponse`, cujo `??`
    // trataria `undefined` como "usar o default" — o que mascararia este caso).
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { accessToken: '1|mock-token-abc' } }));

    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/data\.matricula/);
  });
});

// ── Re-login em 401 ───────────────────────────────────────────────

describe('AxonicoApiClient — re-login em 401', () => {
  it('401 → exatamente 1 re-login → repete a chamada original → sucesso', async () => {
    let loginCount = 0;
    let findCount = 0;
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/login')) {
        loginCount += 1;
        return loginResponse();
      }
      if (url.endsWith('/api/paciente/filter')) {
        findCount += 1;
        if (findCount === 1) return jsonResponse({ message: 'Unauthenticated' }, 401);
        return pacienteFilterResponse([]);
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const client = makeClient();
    const result = await client.findPatientByDni('30712345');

    expect(result).toBeNull();
    expect(findCount).toBe(2); // 1ª deu 401, 2ª (pós re-login) deu certo
    expect(loginCount).toBe(2); // login inicial + re-login após o 401
  });

  it('401 depois do re-login → erro definitivo, sem loop (AxonicoAuthError)', async () => {
    let loginCount = 0;
    let findCount = 0;
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/login')) {
        loginCount += 1;
        return loginResponse();
      }
      if (url.endsWith('/api/paciente/filter')) {
        findCount += 1;
        return jsonResponse({ message: 'Unauthenticated' }, 401);
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toBeInstanceOf(AxonicoAuthError);

    // 1a tentativa (401) + retry pós-relogin (401 de novo) = 2 chamadas à rota, nunca uma 3a.
    expect(findCount).toBe(2);
    expect(loginCount).toBe(2);
  });
});

// ── Conserto 3 (F1) — 401 no PUT NÃO replaya (submitComprobante) ───────────
//
// Espião registra a SEQUÊNCIA de chamadas HTTP (método + rota) para provar exatamente 1 PUT —
// diferente do teste de re-login acima (POST), que continua replayando e tem de continuar verde.

describe('AxonicoApiClient — 401 em escrita (PUT /api/comprobante) NÃO replaya (Conserto F1-3)', () => {
  it('401 no PUT /api/comprobante → submitComprobante rejeita com AxonicoIndeterminateWriteError, e exatamente 1 PUT foi enviado', async () => {
    const httpCalls: Array<{ method: string; url: string }> = [];
    mockFetch.mockImplementation(async (input: unknown, init?: unknown) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      httpCalls.push({ method, url });

      if (url.endsWith('/api/login')) {
        return loginResponse();
      }
      if (url.endsWith('/api/comprobante') && method === 'PUT') {
        return jsonResponse({ message: 'Unauthenticated' }, 401);
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const client = makeClient();
    let caught: unknown;
    try {
      await client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AxonicoIndeterminateWriteError);

    // SAÍDA DO ESPIÃO — sequência de chamadas HTTP registradas:
    // eslint-disable-next-line no-console
    console.log('[espião — 401 no PUT]', JSON.stringify(httpCalls, null, 2));

    const putCalls = httpCalls.filter((c) => c.method === 'PUT' && c.url.endsWith('/api/comprobante'));
    expect(putCalls).toHaveLength(1); // exatamente 1 PUT — nunca um replay automático.
  });

  it('401 no PUT invalida a sessão (próxima chamada, de qualquer método, relogará) mas não repete ESTA escrita', async () => {
    let loginCount = 0;
    mockFetch.mockImplementation(async (input: unknown, init?: unknown) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.endsWith('/api/login')) {
        loginCount += 1;
        return loginResponse();
      }
      if (url.endsWith('/api/comprobante') && method === 'PUT') {
        return jsonResponse({ message: 'Unauthenticated' }, 401);
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const client = makeClient();
    await expect(
      client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      })
    ).rejects.toBeInstanceOf(AxonicoIndeterminateWriteError);

    // Só o login inicial — nenhum re-login disparado (o Conserto 3 lança antes de re-logar e
    // replayar; a sessão é limpa, mas quem decide repetir é humano, num novo `execute`).
    expect(loginCount).toBe(1);
  });
});

// ── findPatientByDni ──────────────────────────────────────────────

describe('AxonicoApiClient — findPatientByDni', () => {
  it('sem match → null', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(pacienteFilterResponse([]));

    const client = makeClient();
    const result = await client.findPatientByDni('99999999');

    expect(result).toBeNull();
  });

  it('com match → historiaClinica e nroCobertura extraídos da 1ª cobertura', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(
      pacienteFilterResponse([
        { historia_clinica: 'HC-123', coberturas: [{ nro_afiliado: 'AF-456' }] },
      ])
    );

    const client = makeClient();
    const result = await client.findPatientByDni('30712345');

    expect(result).toEqual({ historiaClinica: 'HC-123', nroCobertura: 'AF-456' });
  });

  it('doc_tipo enviado é sempre "0" (DNI), medido no corpo da requisição', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(pacienteFilterResponse([]));

    const client = makeClient();
    await client.findPatientByDni('30712345');

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.filters.doc_tipo).toBe('0');
    expect(body.filters.nro_doc).toBe('30712345');
  });

  it('resposta sem a chave "data" (corpo inesperado) é tratada como sem match → null (fallback)', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const client = makeClient();
    const result = await client.findPatientByDni('30712345');

    expect(result).toBeNull();
  });
});

// ── resolveServiceMapping (AxonicoServiceMapping) ─────────────────

describe('AxonicoServiceMapping — resolveServiceMapping', () => {
  it("resolveServiceMapping('CAREGIVER') lança AxonicoUnmappedServiceTypeError sem chamar submitComprobante", async () => {
    const client = makeClient();
    const submitSpy = jest.spyOn(client, 'submitComprobante');

    expect(() => resolveServiceMapping('CAREGIVER')).toThrow(AxonicoUnmappedServiceTypeError);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolveServiceMapping('AT') devolve os códigos medidos (RED CAPITAL)", () => {
    expect(resolveServiceMapping('AT')).toEqual({
      servicioOrigen: '1111',
      codigoEspecialidad: '17',
      codigo: '330123',
      subcodigo: '0',
    });
  });
});

// ── checkExistingComprobante ──────────────────────────────────────

describe('AxonicoApiClient — checkExistingComprobante', () => {
  it('existe pelo menos um comprobante → true', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(comprobanteFilterResponse(1));

    const client = makeClient();
    const result = await client.checkExistingComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
    });

    expect(result).toBe(true);
  });

  it('nenhum comprobante → false', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(comprobanteFilterResponse(0));

    const client = makeClient();
    const result = await client.checkExistingComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
    });

    expect(result).toBe(false);
  });

  it('resposta sem a chave "data" (corpo inesperado) é tratada como sem duplicata → false (fallback)', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const client = makeClient();
    const result = await client.checkExistingComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
    });

    expect(result).toBe(false);
  });

  it('janela do dia inteiro (00:00:00–23:59:59) e matricula da sessão vão no filtro', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse({ matricula: '352722' }));
    mockFetch.mockResolvedValueOnce(comprobanteFilterResponse(0));

    const client = makeClient();
    await client.checkExistingComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
    });

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.filters.fecha_desde).toBe('10/09/2026 00:00:00');
    expect(body.filters.fecha_hasta).toBe('10/09/2026 23:59:59');
    expect(body.filters.whereHasWith.comprobanteDetalle.matricula).toBe('352722');
  });
});

// ── submitComprobante ─────────────────────────────────────────────

describe('AxonicoApiClient — submitComprobante', () => {
  it('sucesso: extrai numeroComprobante e codAutorizacion do TOPO da resposta, nunca de detalle[0]', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(
      submitResponse({
        numero_comprobante: '1407706',
        cod_autorizacion: '111114077061',
        detalleCodAutorizacion: null, // medido: detalle[0].cod_autorizacion vem null na prova real
      })
    );

    const client = makeClient();
    const result = await client.submitComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
      cantidad: 1,
    });

    expect(result).toEqual({ numeroComprobante: '1407706', codAutorizacion: '111114077061' });
  });

  it('fecha = data do pedido (service_date) + hora do INSTANTE do envio, relógio fixado', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(submitResponse());

    const client = makeClient(() => FIXED_NOW);
    await client.submitComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
      cantidad: 1,
    });

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    // service_date = 10/09/2026, relógio fixado em 14:32:00 — nunca a hora real do plantão.
    expect(body.fecha).toBe('10/09/2026 14:32:00');
  });

  it('matricula (detalhe) vem da sessão autenticada, nunca constante literal', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse({ matricula: '999888' }));
    mockFetch.mockResolvedValueOnce(submitResponse());

    const client = makeClient();
    await client.submitComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
      cantidad: 1,
    });

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.detalle[0].matricula).toBe('999888');
    // Constantes de contrato permitidas — só estas.
    expect(body.tipo_prest).toBe('P');
    expect(body.detalle[0].prestacion_medicamento).toBe('P');
    expect(body.matricula_solicitante).toBe('999999');
  });

  it('campos vazios são omitidos do corpo, nunca enviados como string vazia', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(submitResponse());

    const client = makeClient();
    await client.submitComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: '', // vazio de propósito
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
      cantidad: 1,
    });

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect('nro_cobertura' in body).toBe(false);
  });

  it('HTTP 200 sem numero_comprobante no corpo é tratado como falha (não booleano)', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }, 200));

    const client = makeClient();
    await expect(
      client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      })
    ).rejects.toBeInstanceOf(AxonicoBusinessError);
  });
});

// ── Erros tipados por status ───────────────────────────────────────

describe('AxonicoApiClient — erros tipados', () => {
  it('422 → AxonicoValidationError com data.errors', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { errors: { cantidad: ['debe ser un entero'] } } }, 422)
    );

    const client = makeClient();
    let caught: unknown;
    try {
      await client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AxonicoValidationError);
    expect((caught as AxonicoValidationError).fieldErrors).toEqual({ cantidad: ['debe ser un entero'] });
  });

  it('422 sem data.errors no corpo → AxonicoValidationError com fieldErrors vazio (fallback)', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 422));

    const client = makeClient();
    let caught: unknown;
    try {
      await client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AxonicoValidationError);
    expect((caught as AxonicoValidationError).fieldErrors).toEqual({});
  });

  it('500 sem data.message no corpo → AxonicoBusinessError com mensagem de fallback "HTTP 500"', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    const client = makeClient();
    let caught: unknown;
    try {
      await client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AxonicoBusinessError);
    expect((caught as Error).message).toContain('HTTP 500');
  });

  it.each([400, 403, 412, 500])('%i → AxonicoBusinessError com data.message', async (status) => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { message: 'erro de negócio' } }, status));

    const client = makeClient();
    let caught: unknown;
    try {
      await client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AxonicoBusinessError);
    expect((caught as AxonicoBusinessError).status).toBe(status);
  });
});

// ── Vocabulário: só a chave canônica em inglês (CAREGIVER) é válida ───

describe('AxonicoApiClient — vocabulário', () => {
  it('AT é o único tipo mapeado hoje; qualquer outro tipo canônico lança erro explícito', () => {
    const outrosTipos: Array<'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST'> = [
      'CAREGIVER',
      'NURSE',
      'KINESIOLOGIST',
      'PSYCHOLOGIST',
    ];
    for (const tipo of outrosTipos) {
      expect(() => resolveServiceMapping(tipo)).toThrow(AxonicoUnmappedServiceTypeError);
    }
  });
});

// ── login: falhas ───────────────────────────────────────────────────

describe('AxonicoApiClient — login: falhas', () => {
  it('login com HTTP não-ok lança erro explícito', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/login failed — HTTP 500/);
  });

  it('login sem data.accessToken lança erro explícito', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { matricula: '352722' } }));

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/data\.accessToken/);
  });
});

// ── Fábricas: fromEnv / fromSecretManager / create ────────────────────

describe('AxonicoApiClient — fábricas', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AXIONICO_USERNAME;
    delete process.env.AXIONICO_PASSWORD;
    delete process.env.AXONICO_BASE_URL;
    mockAccessSecretVersion.mockReset();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('fromEnv() usa AXIONICO_USERNAME/AXIONICO_PASSWORD e AXONICO_BASE_URL do ambiente', () => {
    process.env.AXIONICO_USERNAME = 'user-env';
    process.env.AXIONICO_PASSWORD = 'pass-env';
    process.env.AXONICO_BASE_URL = 'http://stub-env:9912';

    const client = AxonicoApiClient.fromEnv();

    expect(client).toBeInstanceOf(AxonicoApiClient);
  });

  it('fromEnv() lança erro explícito quando faltam as envs', () => {
    expect(() => AxonicoApiClient.fromEnv()).toThrow(/AXIONICO_USERNAME and AXIONICO_PASSWORD/);
  });

  it('fromSecretManager() busca username/password no Secret Manager', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('user-sm') } }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('pass-sm') } }]);

    const client = await AxonicoApiClient.fromSecretManager();

    expect(client).toBeInstanceOf(AxonicoApiClient);
    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it('fromSecretManager() lança erro explícito quando os secrets vêm vazios', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce([{ payload: undefined }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('pass-sm') } }]);

    await expect(AxonicoApiClient.fromSecretManager()).rejects.toThrow(/secrets returned empty values/);
  });

  it('create() usa fromEnv quando AXIONICO_USERNAME/AXIONICO_PASSWORD estão presentes', async () => {
    process.env.AXIONICO_USERNAME = 'user-env';
    process.env.AXIONICO_PASSWORD = 'pass-env';

    const client = await AxonicoApiClient.create();

    expect(client).toBeInstanceOf(AxonicoApiClient);
    expect(mockAccessSecretVersion).not.toHaveBeenCalled();
  });

  it('create() cai no Secret Manager quando as envs não estão presentes', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('user-sm') } }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('pass-sm') } }]);

    const client = await AxonicoApiClient.create();

    expect(client).toBeInstanceOf(AxonicoApiClient);
    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
  });
});

// ── Relógio default e parse de erro sem corpo JSON válido ─────────────

describe('AxonicoApiClient — relógio default e parse defensivo de erro', () => {
  it('sem `now` injetado, usa o relógio real (Date) — não quebra e monta `fecha` no formato certo', async () => {
    // client SEM 4º argumento — exercita o default `now ?? (() => new Date())`.
    const client = new AxonicoApiClient('RIATSRL', 'senha-fake-de-teste', 'http://localhost:9912');
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(submitResponse());

    await client.submitComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
      cantidad: 1,
    });

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.fecha).toMatch(/^10\/09\/2026 \d{2}:\d{2}:\d{2}$/);
  });

  it('corpo de erro que não é JSON válido cai no fallback ({}) — ainda assim erro tipado', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('corpo não é JSON')),
    } as unknown as Response);

    const client = makeClient();
    let caught: unknown;
    try {
      await client.submitComprobante({
        historiaClinica: 'HC-123',
        nroCobertura: 'AF-456',
        serviceCodes: SERVICE_CODES,
        serviceDate: SERVICE_DATE,
        cantidad: 1,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AxonicoBusinessError);
    expect((caught as Error).message).toContain('HTTP 500');
  });
});

// ── Conserto 2 — validação numérica em runtime de cantidad_max_prestaciones (D371) ──
//
// `body.data as AxonicoMedicoParametroPortalResponseBody` é asserção de tipo, não validação —
// a API do Axonico comprovadamente serializa numérico como string em outros campos
// (`cantidad: String(cantidad)` em `submitComprobante`), então `number` cravado no tipo era
// hipótese. Tabela de casos: entrada → o que `getCantidadMaxPrestaciones` devolve, medido contra
// `fetch` mockado (ZERO rede).

describe('AxonicoApiClient — getCantidadMaxPrestaciones (Conserto 2, validação runtime)', () => {
  function medicoParametroPortalResponse(cantidadMaxPrestaciones: unknown, fieldPresent = true) {
    const entry = fieldPresent ? { cantidad_max_prestaciones: cantidadMaxPrestaciones } : {};
    return jsonResponse({ data: [entry] });
  }

  const CASOS: Array<{ nome: string; entrada: unknown; esperado: number | null; fieldPresent?: boolean }> = [
    { nome: '24 (number)', entrada: 24, esperado: 24 },
    { nome: '"24" (string numérica)', entrada: '24', esperado: 24 },
    { nome: '"abc" (string não-numérica)', entrada: 'abc', esperado: null },
    { nome: '"" (string vazia)', entrada: '', esperado: null },
    { nome: 'null', entrada: null, esperado: null },
    { nome: 'undefined (campo presente, valor undefined)', entrada: undefined, esperado: null },
    { nome: '0 (teto zero — leitura sem sentido, não "recusa tudo")', entrada: 0, esperado: null },
    { nome: '-1 (negativo)', entrada: -1, esperado: null },
    { nome: 'true (booleano)', entrada: true, esperado: null },
    { nome: '{} (objeto)', entrada: {}, esperado: null },
    { nome: '[] (array)', entrada: [], esperado: null },
    { nome: 'NaN', entrada: NaN, esperado: null },
    { nome: 'Infinity', entrada: Infinity, esperado: null },
    { nome: '"24 hs" (string com sufixo não-numérico)', entrada: '24 hs', esperado: null },
    { nome: 'campo ausente do corpo', entrada: undefined, esperado: null, fieldPresent: false },
  ];

  it.each(CASOS)('$nome → $esperado', async ({ entrada, esperado, fieldPresent }) => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(medicoParametroPortalResponse(entrada, fieldPresent ?? true));

    const client = makeClient();
    const result = await client.getCantidadMaxPrestaciones();

    expect(result).toBe(esperado);
  });

  it('resposta sem a chave "data" (corpo inesperado) é tratada como ausente → null', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const client = makeClient();
    const result = await client.getCantidadMaxPrestaciones();

    expect(result).toBeNull();
  });

  it('matricula enviada no filtro vem da sessão autenticada', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse({ matricula: '777888' }));
    mockFetch.mockResolvedValueOnce(medicoParametroPortalResponse(24));

    const client = makeClient();
    await client.getCantidadMaxPrestaciones();

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.filters.matricula).toBe('777888');
  });
});

// ── Espião de rede: zero chamadas reais ao Axonico ──────────────────
//
// `allRequestedUrls` (declarado no topo do arquivo) acumula toda URL vista pelo wrapper de
// `global.fetch` durante TODA a suíte — inclusive as chamadas feitas via `mockResolvedValueOnce`,
// que não passam pela implementação base do `jest.fn`. `afterAll` roda depois do último teste e
// varre o array inteiro.

afterAll(() => {
  const realHostHits = allRequestedUrls.filter(
    (url) => url.includes('api.apiws.axonico.ar') || url.includes('api.his.axonico.ar')
  );
  // eslint-disable-next-line no-console
  console.log(
    `[espião de rede] URLs vistas: ${allRequestedUrls.length}; hits em host real do Axonico: ${realHostHits.length}`
  );
  expect(realHostHits).toEqual([]);
});
