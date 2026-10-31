import { Request, Response, NextFunction } from 'express';

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

import { requireServicoAssistentes } from '../requireServicoAssistentes';
import {
  AUDIENCIA_ASSISTENTES,
  GoogleVerificadorIdentidadeServico,
  MockVerificadorIdentidadeServico,
  VerificadorIdentidadeServico,
  criarVerificadorIdentidadeServico,
  lerAllowlistServico,
} from '../../../infrastructure/VerificadorIdentidadeServico';

const SA = 'gestoras-service-sa@projeto-teste.iam.gserviceaccount.com';
const SA_OUTRO = 'outra-sa@projeto-x.iam.gserviceaccount.com';

function chamar(mw: ReturnType<typeof requireServicoAssistentes>, headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return mw(req, res, next).then(() => ({ res, next }));
}
const falso = (payload: object): VerificadorIdentidadeServico => ({
  verificar: jest.fn().mockResolvedValue(payload),
});

describe('requireServicoAssistentes', () => {
  const envOriginal = process.env;
  beforeEach(() => {
    process.env = { ...envOriginal, GCP_PROJECT_ID: 'projeto-teste' };
    delete process.env.USE_MOCK_AUTH;
    mockVerifyIdToken.mockReset();
  });
  afterEach(() => {
    process.env = envOriginal;
  });

  it('sem header X-Enlite-Servico -> 401 SERVICO_NAO_AUTENTICADO', async () => {
    const { res, next } = await chamar(requireServicoAssistentes(falso({ email: SA, email_verified: true })));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'SERVICO_NAO_AUTENTICADO' });
    expect(next).not.toHaveBeenCalled();
  });

  it('X-Internal-Secret e X-Serverless-Authorization nao substituem o header proprio -> 401', async () => {
    const { res, next } = await chamar(requireServicoAssistentes(falso({ email: SA, email_verified: true })), {
      'x-internal-secret': 'x',
      'x-serverless-authorization': 'Bearer t',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('token de outra audiencia -> 401 (verificador real pede a audiencia certa e rejeita)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Wrong recipient'));
    const mw = requireServicoAssistentes(new GoogleVerificadorIdentidadeServico());
    const { res, next } = await chamar(mw, { 'x-enlite-servico': 'Bearer tok' });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'tok', audience: AUDIENCIA_ASSISTENTES });
    expect(AUDIENCIA_ASSISTENTES).toBe('https://api.enlite.health/assistentes');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('sem argumento (como no contrato) e sem USE_MOCK_AUTH usa o verificador Google com a audiencia certa', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: SA, email_verified: true }) });
    const { res, next } = await chamar(requireServicoAssistentes(), { 'x-enlite-servico': 'Bearer tok' });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'tok', audience: AUDIENCIA_ASSISTENTES });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('email_verified=false -> 401', async () => {
    const { res, next } = await chamar(requireServicoAssistentes(falso({ email: SA, email_verified: false })), {
      'x-enlite-servico': 'Bearer tok',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('email fora da allowlist (SA de outro projeto) -> 401', async () => {
    const { res, next } = await chamar(requireServicoAssistentes(falso({ email: SA_OUTRO, email_verified: true })), {
      'x-enlite-servico': 'Bearer tok',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('email da SA do servico -> next()', async () => {
    const { res, next } = await chamar(requireServicoAssistentes(falso({ email: SA, email_verified: true })), {
      'x-enlite-servico': 'Bearer tok',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('wiring: fora de USE_MOCK_AUTH=true o verificador de teste NAO e injetavel', () => {
    const deTeste = falso({ email: SA, email_verified: true });
    expect(criarVerificadorIdentidadeServico(deTeste, {})).toBeInstanceOf(GoogleVerificadorIdentidadeServico);
    expect(criarVerificadorIdentidadeServico(deTeste, { USE_MOCK_AUTH: 'false' })).toBeInstanceOf(
      GoogleVerificadorIdentidadeServico,
    );
    expect(criarVerificadorIdentidadeServico(deTeste, { USE_MOCK_AUTH: 'true' })).toBe(deTeste);
  });

  describe('verificador de teste embutido (sob USE_MOCK_AUTH=true)', () => {
    const tokenMock = (d: object) => `mock_${Buffer.from(JSON.stringify(d)).toString('base64')}`;
    const bom = { email: SA, email_verified: true, aud: AUDIENCIA_ASSISTENTES };
    const via = async (token: string) => {
      process.env.USE_MOCK_AUTH = 'true';
      return chamar(requireServicoAssistentes(), { 'x-enlite-servico': `Bearer ${token}` });
    };

    it('sem USE_MOCK_AUTH=true o mock NUNCA e escolhido (nem sem env, nem com false/True/1)', () => {
      for (const env of [{}, { USE_MOCK_AUTH: 'false' }, { USE_MOCK_AUTH: 'True' }, { USE_MOCK_AUTH: '1' }]) {
        expect(criarVerificadorIdentidadeServico(undefined, env)).toBeInstanceOf(GoogleVerificadorIdentidadeServico);
        expect(criarVerificadorIdentidadeServico(undefined, env)).not.toBeInstanceOf(MockVerificadorIdentidadeServico);
      }
      expect(criarVerificadorIdentidadeServico(undefined, { USE_MOCK_AUTH: 'true' })).toBeInstanceOf(
        MockVerificadorIdentidadeServico,
      );
    });

    it('sem USE_MOCK_AUTH o token mock_ e rejeitado com 401 (so o Google valeria)', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('Invalid token'));
      const { res, next } = await chamar(requireServicoAssistentes(), { 'x-enlite-servico': `Bearer ${tokenMock(bom)}` });
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('sob o mock: token bom (audiencia, email_verified, allowlist) -> next()', async () => {
      const { res, next } = await via(tokenMock(bom));
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it.each([
      ['outra audiencia', { ...bom, aud: 'https://outra.audiencia' }],
      ['email_verified=false', { ...bom, email_verified: false }],
      ['email fora da allowlist', { ...bom, email: SA_OUTRO }],
    ])('sob o mock: %s -> 401', async (_nome, payload) => {
      const { res, next } = await via(tokenMock(payload));
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('sob o mock: token sem prefixo mock_ ou base64 invalido -> 401', async () => {
      for (const t of ['abc', 'mock_%%%nao-json']) {
        const { res, next } = await via(t);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
      }
    });
  });

  it('allowlist vem de GCP_PROJECT_ID (sem env nova; sem projeto -> vazia e nega)', async () => {
    expect(lerAllowlistServico({ GCP_PROJECT_ID: 'projeto-teste' })).toEqual([SA]);
    expect(lerAllowlistServico({})).toEqual([]);
    delete process.env.GCP_PROJECT_ID;
    const { res, next } = await chamar(requireServicoAssistentes(falso({ email: SA, email_verified: true })), {
      'x-enlite-servico': 'Bearer tok',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
