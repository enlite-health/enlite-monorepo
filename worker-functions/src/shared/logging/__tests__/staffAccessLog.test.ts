import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Request } from 'express';
import { correlationMiddleware } from '../correlationMiddleware';
import { loggingAls } from '../als';
import {
  STAFF_ACCESS_EVENT,
  UNMATCHED_ROUTE,
  createStaffAccessLogMiddleware,
  createStaffAccessLogger,
  isStaffAccessLogEnabled,
  routeTemplate,
  staffAccessLogMiddleware,
  staffUidFromAls,
} from '../staffAccessLog';
import type { ActorContext } from '@shared/audit/actorSource';

/** Coleta as linhas que o pino REAL emitiu — é assim que se prova a ausência de `traceId`. */
function memorySink() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk));
      },
    },
  };
}

/**
 * Sobe um app Express REAL com router montado e faz uma request de verdade.
 * Mock não serve aqui: o que está sob teste é o comportamento do Express
 * (`req.baseUrl`/`req.route` no evento `finish`) e a propagação do ALS para o
 * listener — nenhum dos dois existe num `Response` falso.
 */
async function requestWith(opts: {
  actor?: ActorContext;
  path?: string;
  enabled?: boolean;
}): Promise<Record<string, unknown>[]> {
  const previous = process.env.STAFF_ACCESS_LOG_ENABLED;
  process.env.STAFF_ACCESS_LOG_ENABLED = opts.enabled === false ? 'false' : 'true';

  const sink = memorySink();
  const app = express();
  app.use(correlationMiddleware);
  app.use(createStaffAccessLogMiddleware(createStaffAccessLogger(sink.stream)));
  app.use((_req, _res, next) => {
    const store = loggingAls.getStore();
    if (store && opts.actor) store.actor = opts.actor;
    next();
  });

  const router = express.Router();
  router.get('/workers/:id', (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.use('/api/admin', router);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => {
    http
      .get(`http://127.0.0.1:${port}${opts.path ?? '/api/admin/workers/9f1c-uuid-real?q=segredo'}`, (res) => {
        res.resume();
        res.once('end', () => setTimeout(resolve, 20));
      })
      .end();
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previous === undefined) delete process.env.STAFF_ACCESS_LOG_ENABLED;
  else process.env.STAFF_ACCESS_LOG_ENABLED = previous;

  return sink.lines;
}

const staff: ActorContext = { source: 'admin_panel', id: 'staff:DX8fmELP0ea3P3GbJav4k1yYRr62' };

describe('staffAccessLog', () => {
  test('Test 1 — request de staff emite UMA linha com uid, rota-template, método e status', async () => {
    const lines = await requestWith({ actor: staff });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: STAFF_ACCESS_EVENT,
      uid: 'DX8fmELP0ea3P3GbJav4k1yYRr62',
      method: 'GET',
      route: '/api/admin/workers/:id',
      status: 201,
      severity: 'INFO',
    });
  });

  test('Test 2 — (lex M1-5) a linha NÃO carrega traceId, e não vaza identificador nem query string', async () => {
    const lines = await requestWith({ actor: staff });

    expect(Object.keys(lines[0])).not.toContain('traceId');
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('9f1c-uuid-real');
    expect(serialized).not.toContain('segredo');
  });

  test('Test 3 — flag desligada não emite nada', async () => {
    expect(await requestWith({ actor: staff, enabled: false })).toHaveLength(0);
  });

  test('Test 4 — prestador no app (worker_self) não entra na medição', async () => {
    const lines = await requestWith({ actor: { source: 'worker_self', id: 'uid-do-candidato' } });
    expect(lines).toHaveLength(0);
  });

  test('Test 5 — request sem ator (não autenticada) não emite nada', async () => {
    expect(await requestWith({})).toHaveLength(0);
  });

  test('Test 6 — rota que o Express não casou vira <unmatched>, nunca a URL crua', async () => {
    const lines = await requestWith({ actor: staff, path: '/api/admin/rota-que-nao-existe/uuid-123' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: UNMATCHED_ROUTE, status: 404 });
    expect(JSON.stringify(lines[0])).not.toContain('uuid-123');
  });
});

describe('staffUidFromAls', () => {
  test('Test 7 — ator de staff sem o prefixo esperado é recusado', () => {
    loggingAls.run({ traceId: 't', actor: { source: 'admin_panel', id: 'DX8fmELP' } }, () => {
      expect(staffUidFromAls()).toBeNull();
    });
  });

  test('Test 8 — prefixo sem uid é recusado', () => {
    loggingAls.run({ traceId: 't', actor: { source: 'admin_panel', id: 'staff:' } }, () => {
      expect(staffUidFromAls()).toBeNull();
    });
  });

  test('Test 9 — fora de request (job) é no-op', () => {
    expect(staffUidFromAls()).toBeNull();
  });
});

describe('routeTemplate', () => {
  test('Test 10 — rota não-string (regex/array) vira <unmatched>', () => {
    const req = { route: { path: /^\/x/ }, baseUrl: '/api' } as unknown as Request;
    expect(routeTemplate(req)).toBe(UNMATCHED_ROUTE);
  });

  test('Test 11 — template vazio vira <unmatched>', () => {
    const req = { route: { path: '' }, baseUrl: '' } as unknown as Request;
    expect(routeTemplate(req)).toBe(UNMATCHED_ROUTE);
  });

  test('Test 12 — sem baseUrl usa só o path da rota', () => {
    const req = { route: { path: '/health' } } as unknown as Request;
    expect(routeTemplate(req)).toBe('/health');
  });
});

describe('isStaffAccessLogEnabled', () => {
  const previous = process.env.STAFF_ACCESS_LOG_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.STAFF_ACCESS_LOG_ENABLED;
    else process.env.STAFF_ACCESS_LOG_ENABLED = previous;
  });

  test('Test 13 — só "true" liga; ausente ou qualquer outro valor fica off', () => {
    delete process.env.STAFF_ACCESS_LOG_ENABLED;
    expect(isStaffAccessLogEnabled()).toBe(false);
    process.env.STAFF_ACCESS_LOG_ENABLED = '1';
    expect(isStaffAccessLogEnabled()).toBe(false);
    process.env.STAFF_ACCESS_LOG_ENABLED = 'true';
    expect(isStaffAccessLogEnabled()).toBe(true);
  });
});

describe('export default do módulo', () => {
  test('Test 14 — o middleware exportado é o que o index.ts monta, e respeita a flag', () => {
    delete process.env.STAFF_ACCESS_LOG_ENABLED;
    const next = jest.fn();
    const on = jest.fn();
    staffAccessLogMiddleware({} as Request, { on } as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(on).not.toHaveBeenCalled();
  });
});
