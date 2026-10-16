/** InterviewHostController (spec 055): validação do corpo e tradução dos erros de domínio em status com `code` estável. */
import type { Request, Response } from 'express';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));
jest.mock('@modules/conversation/interfaces/controllers/ConversationActor', () => {
  class MissingActorError extends Error {}
  return { MissingActorError, actorUid: () => 'staff-1' };
});

import { InterviewHostController } from '../InterviewHostController';
import {
  InterviewHostAlreadyActiveError,
  InterviewHostNotFoundError,
  InterviewHostUserNotEligibleError,
} from '../../../application/InterviewHostErrors';

const ID = '11111111-1111-4111-8111-111111111111';

function res() {
  const r = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  return r;
}
const call = async (fn: (rq: Request, rs: Response) => Promise<void>, req: Partial<Request>) => {
  const r = res();
  await fn(req as Request, r as unknown as Response);
  return { status: r.status.mock.calls[0]?.[0], body: r.json.mock.calls[0]?.[0] };
};

describe('InterviewHostController', () => {
  const service = { list: jest.fn(), candidates: jest.fn(), create: jest.fn(), update: jest.fn() };
  const c = new InterviewHostController(service as never);
  beforeEach(() => jest.clearAllMocks());

  it('POST válido → 201 e o serviço recebe o ator', async () => {
    service.create.mockResolvedValue({ id: ID });
    const out = await call(c.create.bind(c), { body: { userUid: 'u1', countries: ['AR', 'BR'], doesEnquadre: true, doesAdmission: false } });
    expect(out.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith({ userUid: 'u1', countries: ['AR', 'BR'], doesEnquadre: true, doesAdmission: false }, 'staff-1');
  });

  it.each([
    ['sem país', { userUid: 'u1', countries: [], doesEnquadre: true, doesAdmission: true }],
    ['país fora de AR/BR', { userUid: 'u1', countries: ['CL'], doesEnquadre: true, doesAdmission: true }],
    ['país repetido', { userUid: 'u1', countries: ['AR', 'AR'], doesEnquadre: true, doesAdmission: true }],
    ['nenhum fluxo', { userUid: 'u1', countries: ['AR'], doesEnquadre: false, doesAdmission: false }],
    ['campo a mais', { userUid: 'u1', countries: ['AR'], doesEnquadre: true, doesAdmission: true, email: 'x@y.z' }],
  ])('POST %s → 400 sem tocar o serviço', async (_n, body) => {
    const out = await call(c.create.bind(c), { body });
    expect(out.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('erros de domínio viram status com code estável: não-elegível 400, não achou 404, já ativa 409', async () => {
    service.create.mockRejectedValueOnce(new InterviewHostUserNotEligibleError());
    expect(await call(c.create.bind(c), { body: { userUid: 'u', countries: ['AR'], doesEnquadre: true, doesAdmission: true } })).toMatchObject({
      status: 400,
      body: { code: 'INTERVIEW_HOST_USER_NOT_ELIGIBLE' },
    });
    service.update.mockRejectedValueOnce(new InterviewHostNotFoundError());
    expect(await call(c.patch.bind(c), { params: { id: ID }, body: { doesEnquadre: false } })).toMatchObject({ status: 404, body: { code: 'INTERVIEW_HOST_NOT_FOUND' } });
    service.create.mockRejectedValueOnce(new InterviewHostAlreadyActiveError());
    expect(await call(c.create.bind(c), { body: { userUid: 'u', countries: ['AR'], doesEnquadre: true, doesAdmission: true } })).toMatchObject({
      status: 409,
      body: { code: 'INTERVIEW_HOST_ALREADY_ACTIVE' },
    });
  });

  it('PATCH com id inválido ou corpo vazio → 400', async () => {
    expect((await call(c.patch.bind(c), { params: { id: 'x' }, body: { doesEnquadre: true } })).status).toBe(400);
    expect((await call(c.patch.bind(c), { params: { id: ID }, body: {} })).status).toBe(400);
  });

  it('candidates exige q', async () => {
    expect((await call(c.candidates.bind(c), { query: {} })).status).toBe(400);
    service.candidates.mockResolvedValue([]);
    expect((await call(c.candidates.bind(c), { query: { q: 'flo' } })).status).toBe(200);
  });

  it('erro inesperado → 500 genérico, sem a mensagem', async () => {
    service.list.mockRejectedValueOnce(new Error('segredo do banco'));
    const out = await call(c.list.bind(c), {});
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain('segredo');
  });
});
