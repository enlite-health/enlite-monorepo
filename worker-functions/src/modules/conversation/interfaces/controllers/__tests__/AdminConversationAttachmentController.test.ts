/**
 * AdminConversationAttachmentController.test.ts — spec 022, Bloco 3 (T311/T312, T314/T315).
 * Molde: `AdminConversationController` (mock de `AuthMiddleware.getAuthContext`,
 * `resolveConversationForPatient`, use cases).
 */
const mockGetAuthContext = jest.fn();
jest.mock('@modules/identity', () => ({
  AuthMiddleware: { getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args) },
}));

const mockResolveConversationForPatient = jest.fn();
jest.mock('../resolveConversationForPatient', () => ({
  resolveConversationForPatient: (...args: unknown[]) => mockResolveConversationForPatient(...args),
}));

import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { AdminConversationAttachmentController } from '../AdminConversationAttachmentController';
import { AttachmentRejectedError } from '../../../application/UploadConversationAttachmentUseCase';
import type { UploadConversationAttachmentUseCase } from '../../../application/UploadConversationAttachmentUseCase';
import type { GetConversationAttachmentUrlUseCase } from '../../../application/GetConversationAttachmentUrlUseCase';

function fakeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

const POOL = {} as unknown as Pool;
const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const FILE_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  mockGetAuthContext.mockReset();
  mockResolveConversationForPatient.mockReset();
});

describe('AdminConversationAttachmentController.upload', () => {
  it('sem arquivo (sem multipart) — 400, nunca chama o use case', async () => {
    const uploadUseCase = { execute: jest.fn() } as unknown as UploadConversationAttachmentUseCase;
    const controller = new AdminConversationAttachmentController(uploadUseCase, undefined, POOL);

    const req = { params: { id: PATIENT_ID } } as unknown as Request;
    const res = fakeRes();
    await controller.upload(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(uploadUseCase.execute).not.toHaveBeenCalled();
  });

  it('paciente inexistente — 404', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: false, conversationId: null });
    const uploadUseCase = { execute: jest.fn() } as unknown as UploadConversationAttachmentUseCase;
    const controller = new AdminConversationAttachmentController(uploadUseCase, undefined, POOL);

    const req = { params: { id: PATIENT_ID }, file: { buffer: Buffer.from('x'), originalname: 'a.pdf' } } as unknown as Request;
    const res = fakeRes();
    await controller.upload(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('sem ator identificado — 401, nunca chama o use case', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: true, conversationId: 'c1' });
    mockGetAuthContext.mockReturnValue(undefined);
    const uploadUseCase = { execute: jest.fn() } as unknown as UploadConversationAttachmentUseCase;
    const controller = new AdminConversationAttachmentController(uploadUseCase, undefined, POOL);

    const req = { params: { id: PATIENT_ID }, file: { buffer: Buffer.from('x'), originalname: 'a.pdf' } } as unknown as Request;
    const res = fakeRes();
    await controller.upload(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(uploadUseCase.execute).not.toHaveBeenCalled();
  });

  it('sucesso — 201 com fileId, use case chamado com conversationId/actorUid/buffer/originalFilename', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: true, conversationId: 'c1' });
    mockGetAuthContext.mockReturnValue({ principal: { id: 'staff:1' } });
    const uploadUseCase = { execute: jest.fn().mockResolvedValue({ fileId: 'f1' }) } as unknown as UploadConversationAttachmentUseCase;
    const controller = new AdminConversationAttachmentController(uploadUseCase, undefined, POOL);

    const req = {
      params: { id: PATIENT_ID },
      file: { buffer: Buffer.from('conteudo'), originalname: 'contrato.pdf' },
    } as unknown as Request;
    const res = fakeRes();
    await controller.upload(req, res);

    expect(uploadUseCase.execute).toHaveBeenCalledWith(POOL, {
      conversationId: 'c1',
      actorUid: 'staff:1',
      buffer: Buffer.from('conteudo'),
      originalFilename: 'contrato.pdf',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { fileId: 'f1' } });
  });

  it('AttachmentRejectedError — traduz status/code/message do erro (413/415 conforme o caso)', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: true, conversationId: 'c1' });
    mockGetAuthContext.mockReturnValue({ principal: { id: 'staff:1' } });
    const rejected = new AttachmentRejectedError('MALICIOUS_CONTENT_DETECTED', 'conteúdo ativo');
    const uploadUseCase = { execute: jest.fn().mockRejectedValue(rejected) } as unknown as UploadConversationAttachmentUseCase;
    const controller = new AdminConversationAttachmentController(uploadUseCase, undefined, POOL);

    const req = { params: { id: PATIENT_ID }, file: { buffer: Buffer.from('x'), originalname: 'a.pdf' } } as unknown as Request;
    const res = fakeRes();
    await controller.upload(req, res);

    expect(res.status).toHaveBeenCalledWith(415);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'conteúdo ativo', code: 'MALICIOUS_CONTENT_DETECTED' });
  });

  it('erro inesperado — 500, nunca vaza a mensagem interna', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: true, conversationId: 'c1' });
    mockGetAuthContext.mockReturnValue({ principal: { id: 'staff:1' } });
    const uploadUseCase = { execute: jest.fn().mockRejectedValue(new Error('boom interno')) } as unknown as UploadConversationAttachmentUseCase;
    const controller = new AdminConversationAttachmentController(uploadUseCase, undefined, POOL);

    const req = { params: { id: PATIENT_ID }, file: { buffer: Buffer.from('x'), originalname: 'a.pdf' } } as unknown as Request;
    const res = fakeRes();
    await controller.upload(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Internal error' });
  });

  it('params inválidos (id não-uuid) — 400', async () => {
    const uploadUseCase = { execute: jest.fn() } as unknown as UploadConversationAttachmentUseCase;
    const controller = new AdminConversationAttachmentController(uploadUseCase, undefined, POOL);

    const req = { params: { id: 'nao-uuid' }, file: { buffer: Buffer.from('x'), originalname: 'a.pdf' } } as unknown as Request;
    const res = fakeRes();
    await controller.upload(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('AdminConversationAttachmentController.getUrl', () => {
  it('params inválidos — 400', async () => {
    const controller = new AdminConversationAttachmentController(undefined, undefined, POOL);
    const req = { params: { id: 'x', fileId: 'y' } } as unknown as Request;
    const res = fakeRes();
    await controller.getUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('paciente inexistente — 404', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: false, conversationId: null });
    const controller = new AdminConversationAttachmentController(undefined, undefined, POOL);
    const req = { params: { id: PATIENT_ID, fileId: FILE_ID } } as unknown as Request;
    const res = fakeRes();
    await controller.getUrl(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('arquivo inexistente OU de outro paciente (use case devolve null) — 404, mensagem genérica (nunca distingue a causa)', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: true, conversationId: 'c1' });
    const getUrlUseCase = { execute: jest.fn().mockResolvedValue(null) } as unknown as GetConversationAttachmentUrlUseCase;
    const controller = new AdminConversationAttachmentController(undefined, getUrlUseCase, POOL);

    const req = { params: { id: PATIENT_ID, fileId: FILE_ID } } as unknown as Request;
    const res = fakeRes();
    await controller.getUrl(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'File not found' });
  });

  it('sucesso — 200 com url/expiresInSeconds, use case chamado com patientId/fileId da rota', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: true, conversationId: 'c1' });
    const getUrlUseCase = {
      execute: jest.fn().mockResolvedValue({ url: 'https://signed.example/x', expiresInSeconds: 300 }),
    } as unknown as GetConversationAttachmentUrlUseCase;
    const controller = new AdminConversationAttachmentController(undefined, getUrlUseCase, POOL);

    const req = { params: { id: PATIENT_ID, fileId: FILE_ID } } as unknown as Request;
    const res = fakeRes();
    await controller.getUrl(req, res);

    expect(getUrlUseCase.execute).toHaveBeenCalledWith(POOL, { patientId: PATIENT_ID, fileId: FILE_ID });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { url: 'https://signed.example/x', expiresInSeconds: 300 } });
  });

  it('erro inesperado — 500', async () => {
    mockResolveConversationForPatient.mockResolvedValue({ patientExists: true, conversationId: 'c1' });
    const getUrlUseCase = { execute: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as GetConversationAttachmentUrlUseCase;
    const controller = new AdminConversationAttachmentController(undefined, getUrlUseCase, POOL);

    const req = { params: { id: PATIENT_ID, fileId: FILE_ID } } as unknown as Request;
    const res = fakeRes();
    await controller.getUrl(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
