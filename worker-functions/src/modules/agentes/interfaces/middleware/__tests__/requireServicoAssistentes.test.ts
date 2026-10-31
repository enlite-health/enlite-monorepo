import { Request, Response, NextFunction } from 'express';

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

import { requireServicoAssistentes } from '../requireServicoAssistentes';
import {
  AUDIENCIA_ASSISTENTES,
  GoogleVerificadorIdentidadeServico,
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
