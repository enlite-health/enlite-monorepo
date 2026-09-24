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

// Mock do logger — mesmo padrão de LancarPrestacaoAxonicoUseCase.test.ts. Usado pela suíte de
// observabilidade (auditoria D384, 20/09/2026) para provar que CADA log novo de nível `error` é
// emitido no caminho de falha correspondente — sem isto, o log é uma alegação sem prova.
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger: mockLogger } = require('@shared/logging') as {
  logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
};

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
    // `throwTypedError` lê o corpo de erro por `.text()` (24/09/2026 — corpo cru, nunca `.json()`
    // direto, pra não perder corpo não-JSON). Mantém o MESMO corpo serializado, pra não divergir
    // do que `json()` já devolvia.
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

/** Corpo de erro que NÃO é JSON — proxy/HTML de erro ou texto plano do Axonico. */
function textResponse(rawBody: string, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('corpo não é JSON')),
    text: () => Promise.resolve(rawBody),
  } as Response;
}

// Formato MEDIDO por HTTP real em 18/09/2026: `medico` é bloco IRMÃO de `data` (nunca
// `data.matricula`, que não existe na resposta real).
function loginResponse(overrides: { accessToken?: string; matricula?: string } = {}) {
  return jsonResponse({
    data: { accessToken: overrides.accessToken ?? '1|mock-token-abc' },
    medico: { matricula: overrides.matricula ?? '352722' },
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
// Dia civil como STRING 'YYYY-MM-DD' (nunca Date — a mudança desta frente).
const SERVICE_DATE = '2026-09-10';

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

  it('login sem medico.matricula falha explicitamente (nunca cai em constante) — e loga error com durationMs, nunca a matricula', async () => {
    const client = makeClient();
    // Corpo SEM o bloco `medico` de propósito (não usar o helper `loginResponse`, cujo `??`
    // trataria `undefined` como "usar o default" — o que mascararia este caso).
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { accessToken: '1|mock-token-abc' } }));

    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/medico\.matricula/);

    // Teste que morre (item 5): prova que o log de erro do guard de matricula é EMITIDO no
    // caminho de falha — não só que a exceção foi lançada.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringMatching(/medico\.matricula ausente/i), durationMs: expect.any(Number) }),
    );
  });

  it('login com medico.matricula vazio (string em branco) falha explicitamente', async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { accessToken: '1|mock-token-abc' }, medico: { matricula: '   ' } })
    );

    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/medico\.matricula/);
  });

  it('login com medico.matricula em formato inesperado (objeto) falha explicitamente', async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { accessToken: '1|mock-token-abc' }, medico: { matricula: {} } })
    );

    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/medico\.matricula/);
  });

  it('sessão sai com matricula "352722" a partir do corpo REAL medido (medico irmão de data, com os campos irmãos links/menuOpcionesNiveles/permisos)', async () => {
    // Corpo LITERAL medido por HTTP real em 18/09/2026 — não usa o helper `loginResponse`, para
    // provar que o parse sobrevive ao formato real inteiro, não só ao subset que o helper monta.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          accessToken: '1|mock-token-abc',
          apellido1: 'Perez',
          email: 'mock@axonico.ar',
          estado: 'A',
          fecha_vencpass: '2027-01-01',
          id: 1,
          nombre: 'Juan',
          usuario: 'RIATSRL',
        },
        medico: { matricula: '352722' },
        links: {},
        menuOpcionesNiveles: {},
        permisos: {},
      })
    );
    mockFetch.mockResolvedValueOnce(comprobanteFilterResponse(0));

    const client = makeClient();
    // Prova OBSERVÁVEL: `checkExistingComprobante` manda `matricula` no filtro
    // (`filters.whereHasWith.comprobanteDetalle.matricula`), lida do espião do fetch.
    await client.checkExistingComprobante({
      historiaClinica: 'HC-123',
      nroCobertura: 'AF-456',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE,
    });

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.filters.whereHasWith.comprobanteDetalle.matricula).toBe('352722');
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

    // Teste que morre (item 5): o 401 persistente é um "erro do terceiro" que exige ação — tem
    // que aparecer como `error`, carregando method+path+durationMs, nunca só a exceção lançada.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/401 persistente/i),
        method: 'POST',
        path: '/api/paciente/filter',
        durationMs: expect.any(Number),
      }),
    );
  });
});

describe('AxonicoApiClient — withReauth: falha de rede (sem resposta HTTP)', () => {
  it('fetch rejeita na 1ª tentativa (timeout/DNS) → relança o erro original e loga error com method+path+durationMs+errorMessage', async () => {
    const networkError = new Error('ETIMEDOUT — request timed out');
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockRejectedValueOnce(networkError);

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toBe(networkError);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/falha de rede/i),
        method: 'POST',
        path: '/api/paciente/filter',
        durationMs: expect.any(Number),
        errorMessage: 'ETIMEDOUT — request timed out',
      }),
    );
  });

  it('fetch dá 401 (dispara re-login) e a 2ª tentativa (pós-relogin) rejeita por falha de rede → relança o erro original e loga a variante "após re-login"', async () => {
    const networkError = new Error('ECONNRESET — connection reset');
    let findCount = 0;
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/login')) {
        return loginResponse();
      }
      if (url.endsWith('/api/paciente/filter')) {
        findCount += 1;
        if (findCount === 1) return jsonResponse({ message: 'Unauthenticated' }, 401);
        throw networkError;
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toBe(networkError);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/falha de rede.*após re-login/i),
        method: 'POST',
        path: '/api/paciente/filter',
        durationMs: expect.any(Number),
        errorMessage: 'ECONNRESET — connection reset',
      }),
    );
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

    // Teste que morre (item 5): estado INDETERMINADO (pode ter faturado sem confirmação) tem que
    // ficar em `error` — é o caso que mais exige atenção humana no fluxo inteiro.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/estado INDETERMINADO/i),
        method: 'PUT',
        path: '/api/comprobante',
        durationMs: expect.any(Number),
      }),
    );
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

    // Teste que morre (item 5) + item 2 do contrato (status + "por quê"): loga error com status
    // 422, method/path do PUT, e as CHAVES dos campos inválidos — nunca os valores submetidos.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/erro do terceiro.*422/i),
        method: 'PUT',
        path: '/api/comprobante',
        status: 422,
        durationMs: expect.any(Number),
        fieldErrorKeys: ['cantidad'],
      }),
    );
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

    // Teste que morre (item 5): erro de negócio/servidor loga error com status HTTP real e a
    // mensagem que o Axonico devolveu (`axonicoMessage`) — o "por quê" exigido pelo item 2.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/erro do terceiro.*negócio\/servidor/i),
        method: 'PUT',
        path: '/api/comprobante',
        status,
        durationMs: expect.any(Number),
        axonicoMessage: 'erro de negócio',
      }),
    );
  });

  // ── Corpo cru — corpo real do Axonico que não é `data.message` (24/09/2026) ──────────

  it('400 com `message` na RAIZ (padrão Laravel, sem `data`) → mensagem chega na `AxonicoBusinessError` e no log (`axonicoBody`)', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'La fecha es inválida' }, 400));

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
    expect((caught as Error).message).toContain('La fecha es inválida');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        axonicoMessage: 'La fecha es inválida',
        axonicoBody: expect.stringContaining('La fecha es inválida'),
      }),
    );
  });

  it('400 com corpo TEXTO PLANO (não-JSON, ex. proxy) → mensagem chega com o texto cru', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(textResponse('Bad Request: campo X inválido', 400));

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
    expect((caught as Error).message).toContain('Bad Request: campo X inválido');
  });

  it('400 com corpo VAZIO → mensagem termina em "HTTP 400" (fallback mudo preservado)', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(textResponse('', 400));

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
    expect((caught as Error).message).toMatch(/HTTP 400$/);
  });

  it('400 com corpo contendo sequência de 6+ dígitos (DNI/historia/nro_afiliado) → REDIGIDO na mensagem e no `axonicoBody`, nunca em claro', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(textResponse('Paciente não encontrado: historia 12345678', 400));

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
    expect((caught as Error).message).not.toContain('12345678');
    expect((caught as Error).message).toContain('<redigido>');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        axonicoMessage: expect.not.stringContaining('12345678'),
        axonicoBody: expect.not.stringContaining('12345678'),
      }),
    );
    const loggedCall = mockLogger.error.mock.calls.find(([f]: [{ axonicoBody?: string }]) => f.axonicoBody !== undefined);
    expect(loggedCall?.[0].axonicoBody).toContain('<redigido>');
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
  it('login com HTTP não-ok lança erro explícito — e loga error com status+durationMs (item 2 do contrato: onde+por quê)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/login failed — HTTP 500/);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringMatching(/login.*HTTP não-2xx/i), status: 500, durationMs: expect.any(Number) }),
    );
  });

  it('login sem data.accessToken lança erro explícito — e loga error com durationMs', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: {}, medico: { matricula: '352722' } }));

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toThrow(/data\.accessToken/);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringMatching(/accessToken ausente/i), durationMs: expect.any(Number) }),
    );
  });

  it('login com falha de rede (fetch rejeita, sem resposta HTTP — ex.: timeout/DNS) relança o erro original e loga error com durationMs+errorMessage', async () => {
    const networkError = new Error('ECONNREFUSED — connect failed');
    mockFetch.mockRejectedValueOnce(networkError);

    const client = makeClient();
    await expect(client.findPatientByDni('30712345')).rejects.toBe(networkError);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/login.*falha de rede/i),
        durationMs: expect.any(Number),
        errorMessage: 'ECONNREFUSED — connect failed',
      }),
    );
  });

  it('login OK loga info com durationMs — sucesso também loga (nunca username/password/accessToken/matricula no log)', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(pacienteFilterResponse([]));

    const client = makeClient();
    await client.findPatientByDni('30712345');

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringMatching(/login.*OK/i), durationMs: expect.any(Number) }),
    );
    const loginLogCall = mockLogger.info.mock.calls.find(([arg]) => /login.*OK/i.test(String(arg.msg)));
    expect(JSON.stringify(loginLogCall)).not.toMatch(/RIATSRL|senha-fake-de-teste|mock-token-abc|352722/);
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

  it('leitura do corpo de erro falha (`.text()` rejeita) → cai no fallback mudo "HTTP 500", ainda assim erro tipado', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('corpo não é JSON')),
      text: () => Promise.reject(new Error('corpo não pôde ser lido')),
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

// ── Prova de fuso — dia civil é string, nunca Date (F2, D372-ish) ──────────
//
// A mudança desta frente: `serviceDate` deixou de ser `Date` e passou a ser `'YYYY-MM-DD'`
// exatamente para que NENHUM componente de fuso participe do dia civil. Prova em duas partes:
//   (a) controle — `process.env.TZ` REALMENTE muda como `Date` lê seus componentes neste runner,
//       senão o teste (b) seria decorativo (passaria mesmo se o bug tivesse voltado);
//   (b) o próprio cliente, sob TZ que cruzaria a borda da meia-noite se ainda usasse `Date`
//       (Asia/Tokyo, medido no briefing como o fuso que quebra a solução de componentes UTC),
//       monta o MESMO dia civil que sob UTC e sob America/Argentina/Buenos_Aires.
describe('AxonicoApiClient — dia civil não depende do fuso do processo', () => {
  // ⚠️ MEDIDO neste runner (jest + ts-jest, node v24): mutar `process.env.TZ` NO MEIO do processo
  // (com ou sem `jest.resetModules()`) NÃO muda o que `Date`/`getDate()` leem — o offset de fuso
  // fica congelado no que valia quando o processo Node subiu. Confirmado com um teste descartável
  // (`tz.tmp.test.ts`, apagado): `new Date(...).getDate()` continuou `17` depois de
  // `process.env.TZ = 'Asia/Tokyo'` em runtime, inclusive para um `Date` construído DEPOIS da
  // mutação. Um teste que mutasse `process.env.TZ` dentro do `it` seria DECORATIVO — passaria
  // mesmo se o bug original (componentes locais de `Date`) tivesse voltado.
  //
  // O que REALMENTE muda `Date` neste runner é o `TZ` do AMBIENTE do processo ANTES do `node`
  // subir — confirmado com o mesmo descartável rodado via `TZ=UTC npx jest ...` (→ `getDate()=17`)
  // e `TZ=Asia/Tokyo npx jest ...` (→ `getDate()=18`) para o mesmo `new Date('2026-09-17T20:00:00Z')`.
  // Por isso a prova aqui é o caminho honesto descrito no briefing — "rodar o arquivo duas vezes
  // com TZ diferente": o teste abaixo lê `process.env.TZ` (setado pelo COMANDO, não por este
  // arquivo) e é executado duas vezes, uma sob `TZ=UTC` e outra sob `TZ=Asia/Tokyo` (o fuso que o
  // briefing mediu como o que quebraria a solução de componentes UTC do `pg`):
  //   TZ=UTC npx jest src/modules/integration/infrastructure/__tests__/AxonicoApiClient.test.ts --runInBand
  //   TZ=Asia/Tokyo npx jest src/modules/integration/infrastructure/__tests__/AxonicoApiClient.test.ts --runInBand
  // As duas corridas passam com a MESMA asserção de dia civil — a prova é o par de corridas verdes
  // sob TZ diferente, não uma asserção condicional a `process.env.TZ` dentro do teste.

  it('controle: o TZ do AMBIENTE do processo (setado ANTES do jest subir) muda os componentes que Date lê', () => {
    // 2026-09-17T20:00:00Z: em UTC ainda é dia 17; em Tóquio (UTC+9) já é 05:00 do dia 18.
    // Roda sob TZ=UTC E sob TZ=Asia/Tokyo (comando no comentário acima) — comparar a saída das
    // duas corridas é a prova; aqui só travamos que a leitura é consistente com QUALQUER um dos
    // dois fusos suportados pelo comando, nunca um terceiro valor (prova que Date reagiu ao TZ).
    const instant = new Date('2026-09-17T20:00:00Z');
    expect([17, 18]).toContain(instant.getDate());
  });

  it('checkExistingComprobante monta fecha_desde/fecha_hasta com o MESMO dia civil — roda sob TZ=UTC e TZ=Asia/Tokyo (comando acima)', async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce(comprobanteFilterResponse(0));

    await client.checkExistingComprobante({
      historiaClinica: 'HC1',
      nroCobertura: 'NC1',
      serviceCodes: SERVICE_CODES,
      serviceDate: SERVICE_DATE, // '2026-09-10' — string, nunca Date: fuso do processo NUNCA participa
    });

    const filterCall = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/api/comprobante/filter'));
    const body = JSON.parse((filterCall![1] as RequestInit).body as string);
    // MESMO valor exigido nas DUAS corridas (TZ=UTC e TZ=Asia/Tokyo) — é essa igualdade entre as
    // duas corridas, coladas na EVIDÊNCIA do relatório, que prova o conserto.
    expect(body.filters.fecha_desde).toBe('10/09/2026 00:00:00');
    expect(body.filters.fecha_hasta).toBe('10/09/2026 23:59:59');
  });

  it('formatDiaCivilParaAxonico (via checkExistingComprobante) LANÇA para serviceDate fora do formato YYYY-MM-DD', async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(loginResponse());

    await expect(
      client.checkExistingComprobante({
        historiaClinica: 'HC1',
        nroCobertura: 'NC1',
        serviceCodes: SERVICE_CODES,
        serviceDate: '10/09/2026' as unknown as string, // formato errado de propósito
      })
    ).rejects.toThrow(/não é um dia civil/);
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
