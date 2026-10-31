/**
 * Rotas da plataforma para o serviço das gestoras (spec 080, T057): alcance, placar, reporte.
 * Duas identidades (serviço via X-Enlite-Servico + pessoa via Authorization) e célula. Repositório falso:
 * `lerPlacarCom`/`registrarReporteCom` reais rodam no e2e (T063). O verificador do serviço é o REAL, com o
 * `OAuth2Client` do google-auth-library mockado (a rota chama `requireServicoAssistentes()` sem argumento).
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@shared/logging', () => ({
  logger: mockLogger,
  reportError: jest.fn(),
  loggingAls: { getStore: () => undefined },
}));

import { createAdminAssistentesRoutes } from '../adminAssistentesRoutes';
import { AssistentesPlataformaController } from '../../controllers/AssistentesPlataformaController';
import { AlcanceAssistentesUseCase } from '../../../application/AlcanceAssistentesUseCase';
import type { PlacarResult } from '../../../../mcp/infrastructure/AgentesRepository';

const SA = 'gestoras-service-sa@projeto-teste.iam.gserviceaccount.com';
const SERVICO = { 'X-Enlite-Servico': 'Bearer tok-servico' };
const PESSOA = { Authorization: 'Bearer tok-pessoa' };
const AMBAS = { ...SERVICO, ...PESSOA };

const CHAVES_PROIBIDAS = ['texto', 'trecho', 'resumo', 'nome', 'telefone', 'conversa_ref', 'uid', 'email', 'actor', 'changed_by'];

const PLACAR: PlacarResult = {
  operador: 'luz', de: '2026-10-01T00:00:00Z', ate: '2026-10-08T00:00:00Z', veredictos: 4, conversas: 3, nota_media: 7.5, cruza_areas: 1,
  por_regra: [{ regra_ref: 'R-12', violacoes: 2, gravidade_max: 'alta', veredicto_ids: ['11111111-1111-4111-8111-111111111111'] }],
  veredicto_ids: ['11111111-1111-4111-8111-111111111111'],
  graves: [{ veredicto_id: 'v', sensor: 'juiz', inbox: 'i', conversa_ref: 'c-1', ultima_msg_ref: 'm', regra_ref: 'R', gatilho: 'nunca', avaliado_em: '2026-10-02T00:00:00Z' }],
};
const QS = 'operador=luz&de=2026-10-01T00:00:00Z&ate=2026-10-08T00:00:00Z';
const OBS = 'observacao-sigilosa-xyz-123';
const CORPO = {
  gestora: 'maria', operador: 'luz', area: 'recrutamento', caso: 'leve', regra_ref: 'R-12',
  janela_de: '2026-10-01', janela_ate: '2026-10-07', observacao: OBS,
};

function chaves(o: unknown, acc: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => chaves(x, acc));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.push(k); chaves(v, acc); }
  return acc;
}

interface Estado { celulasGuard: string[]; celulasDaPessoa: string[]; reportes: Set<string> }
let st: Estado;
const registrarReporte = jest.fn();
const lerPlacar = jest.fn();

function build() {
  const resolverCelulas = jest.fn(async () => st.celulasDaPessoa);
  const controller = new AssistentesPlataformaController({
    alcance: new AlcanceAssistentesUseCase(resolverCelulas),
    resolverCelulas,
    lerPlacar,
    registrarReporte,
  });
  // Falsos de AuthMiddleware/PermissionMiddleware: a ordem do array é a real; só os guardas são dublês.
  const auth = {
    requireStaff: () => (req: Request, res: Response, next: NextFunction) => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith('Bearer ')) return void res.status(401).json({ error: 'Unauthenticated' });
      (req as unknown as { authContext: unknown }).authContext = { principal: { id: 'uid-gestora' } };
      next();
    },
  };
  const perms = {
    family: () => ({
      require: (recurso: string, acao: string) => (_req: Request, res: Response, next: NextFunction) =>
        st.celulasGuard.includes(`${recurso}:${acao}`) ? next() : void res.status(403).json({ error: 'missing_cell' }),
    }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminAssistentesRoutes(controller, auth as never, perms as never));
  return { app, resolverCelulas };
}

describe('rotas /api/admin de assistentes (plataforma)', () => {
  const envOriginal = process.env;
  beforeEach(() => {
    process.env = { ...envOriginal, GCP_PROJECT_ID: 'projeto-teste' };
    delete process.env.USE_MOCK_AUTH;
    jest.clearAllMocks();
    mockVerifyIdToken.mockImplementation(async ({ idToken }: { idToken: string }) => {
      if (idToken !== 'tok-servico') throw new Error('invalid');
      return { getPayload: () => ({ email: SA, email_verified: true }) };
    });
    st = { celulasGuard: [], celulasDaPessoa: [], reportes: new Set() };
    lerPlacar.mockResolvedValue(PLACAR);
    registrarReporte.mockImplementation(async (_uid: string, r: { operador: string; caso: string }) => {
      const chave = `${r.operador}|${r.caso}`;
      if (st.reportes.has(chave)) return { id: 'rep-1', duplicado: true as const };
      st.reportes.add(chave);
      return { id: 'rep-1' };
    });
  });
  afterEach(() => { process.env = envOriginal; });

  describe('GET /assistentes/alcance', () => {
    it('as duas identidades -> 200 com as células da pessoa', async () => {
      st.celulasDaPessoa = ['assistente_maria:chat', 'conhecimento_publico:read', 'conhecimento_default:read'];
      const { app } = build();
      const r = await request(app).get('/api/admin/assistentes/alcance').set(AMBAS);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ uid: 'uid-gestora', gestoras: ['maria'], conhecimento: ['publico'] });
    });
    it('só a identidade da pessoa -> 401', async () => {
      const r = await request(build().app).get('/api/admin/assistentes/alcance').set(PESSOA);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'SERVICO_NAO_AUTENTICADO' });
    });
    it('só a identidade do serviço -> 401', async () => {
      const r = await request(build().app).get('/api/admin/assistentes/alcance').set(SERVICO);
      expect(r.status).toBe(401);
    });
    it('falha ao resolver as células -> 500, nunca lista vazia', async () => {
      const { app, resolverCelulas } = build();
      resolverCelulas.mockRejectedValueOnce(new Error('cloud sql'));
      const r = await request(app).get('/api/admin/assistentes/alcance').set(AMBAS);
      expect(r.status).toBe(500);
      expect(r.body.gestoras).toBeUndefined();
    });
  });

  describe('GET /agentes/placar', () => {
    it('só a identidade da pessoa -> 401 (falta o serviço)', async () => {
      st.celulasGuard = ['agentes_placar:read'];
      const r = await request(build().app).get(`/api/admin/agentes/placar?${QS}`).set(PESSOA);
      expect(r.status).toBe(401);
      expect(lerPlacar).not.toHaveBeenCalled();
    });
    it('sem agentes_placar:read -> 403', async () => {
      const r = await request(build().app).get(`/api/admin/agentes/placar?${QS}`).set(AMBAS);
      expect(r.status).toBe(403);
      expect(lerPlacar).not.toHaveBeenCalled();
    });
    it('com a célula -> 200 e a saída não tem chaves proibidas (recursivo)', async () => {
      st.celulasGuard = ['agentes_placar:read'];
      const r = await request(build().app).get(`/api/admin/agentes/placar?${QS}`).set(AMBAS);
      expect(r.status).toBe(200);
      const achadas = chaves(r.body);
      expect(achadas).toEqual(expect.arrayContaining(['operador', 'veredictos', 'por_regra', 'regra_ref', 'gravidade_max']));
      for (const proibida of CHAVES_PROIBIDAS) expect(achadas).not.toContain(proibida);
      expect(achadas).not.toContain('graves');
      expect(achadas).not.toContain('veredicto_ids');
    });
    it('query inválida -> 400', async () => {
      st.celulasGuard = ['agentes_placar:read'];
      const r = await request(build().app).get('/api/admin/agentes/placar?operador=Luz&de=x&ate=y').set(AMBAS);
      expect(r.status).toBe(400);
    });
  });

  describe('POST /agentes/reportes', () => {
    beforeEach(() => {
      st.celulasGuard = ['agentes_reporte:registrar'];
      st.celulasDaPessoa = ['assistente_maria:chat'];
    });
    it('sem agentes_reporte:registrar -> 403', async () => {
      st.celulasGuard = [];
      const r = await request(build().app).post('/api/admin/agentes/reportes').set(AMBAS).send(CORPO);
      expect(r.status).toBe(403);
      expect(registrarReporte).not.toHaveBeenCalled();
    });
    it('só a identidade da pessoa -> 401', async () => {
      const r = await request(build().app).post('/api/admin/agentes/reportes').set(PESSOA).send(CORPO);
      expect(r.status).toBe(401);
    });
    it('célula de reporte sem alcance à Maria -> 403', async () => {
      st.celulasDaPessoa = ['assistente_lucero:chat'];
      const r = await request(build().app).post('/api/admin/agentes/reportes').set(AMBAS).send(CORPO);
      expect(r.status).toBe(403);
      expect(registrarReporte).not.toHaveBeenCalled();
    });
    it('corpo com campo extra -> 400 (.strict())', async () => {
      const r = await request(build().app).post('/api/admin/agentes/reportes').set(AMBAS).send({ ...CORPO, trecho: 'x' });
      expect(r.status).toBe(400);
      expect(registrarReporte).not.toHaveBeenCalled();
    });
    it('gestora fora das constantes do catálogo -> 400', async () => {
      const r = await request(build().app).post('/api/admin/agentes/reportes').set(AMBAS).send({ ...CORPO, gestora: 'luz' });
      expect(r.status).toBe(400);
    });
    it('observacao > 500 -> 400', async () => {
      const r = await request(build().app).post('/api/admin/agentes/reportes').set(AMBAS).send({ ...CORPO, observacao: 'a'.repeat(501) });
      expect(r.status).toBe(400);
    });
    it('201 na 1ª vez e 200 duplicado:true na 2ª; autor = gestora do corpo', async () => {
      const { app } = build();
      const a = await request(app).post('/api/admin/agentes/reportes').set(AMBAS).send(CORPO);
      expect(a.status).toBe(201);
      expect(a.body).toEqual({ id: 'rep-1' });
      const b = await request(app).post('/api/admin/agentes/reportes').set(AMBAS).send(CORPO);
      expect(b.status).toBe(200);
      expect(b.body).toEqual({ id: 'rep-1', duplicado: true });
      expect(registrarReporte).toHaveBeenCalledWith('uid-gestora', expect.objectContaining({ autor: 'maria', operador: 'luz', veredicto_ids: [] }));
    });
    it('observacao nunca é logada (nem no caminho de erro)', async () => {
      const { app } = build();
      await request(app).post('/api/admin/agentes/reportes').set(AMBAS).send(CORPO);
      registrarReporte.mockRejectedValueOnce(Object.assign(new Error(`DETAIL: ${OBS}`), { name: 'DbError' }));
      const falha = await request(app).post('/api/admin/agentes/reportes').set(AMBAS).send({ ...CORPO, caso: 'meta' });
      expect(falha.status).toBe(500);
      const logs = [mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug]
        .flatMap((f) => f.mock.calls)
        .map((c) => JSON.stringify(c))
        .join('\n');
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).not.toContain(OBS);
    });
  });
});
