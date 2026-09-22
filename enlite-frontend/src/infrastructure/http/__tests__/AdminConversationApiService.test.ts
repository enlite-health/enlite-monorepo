/**
 * AdminConversationApiService — spec 022, Bloco 2 (T205/T206). Espelha o contrato de
 * `contracts/openapi-conversation.md` (6 rotas sob `/api/admin/patients/:id/conversation`) +
 * `contracts/openapi-staff-directory.md` (autocomplete de menção). Molde: `AdminPatientPhotoApiService.ts`
 * — mesmo padrão de `getAuthHeaders`/`requestJson`.
 *
 * `vi.unstubAllGlobals()` no `afterEach`: sem isso o `fetch` stubado por este arquivo vaza pro
 * `describe` seguinte do mesmo processo de teste (achado do brief desta task).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminConversationApiService } from '../AdminConversationApiService';
import { ApiError } from '../ApiError';

const json = (body: unknown, status = 200): Response =>
  ({ status, json: async () => body } as unknown as Response);

/** Mensagem sintética — nunca texto clínico real (regra dura do CLAUDE.md). */
const syntheticMessage = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  authorUid: 'staff-1',
  authorDisplayName: null,
  body: 'msg-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  mentions: [],
  mentionDisplayNames: {},
  replyCount: 0,
  lastReplyAt: null,
  attachments: [],
  ...overrides,
});

describe('AdminConversationApiService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { token = 'tok'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  // ========== 1. getConversation (GET .../conversation) ==========

  it('getConversation: GET com Authorization, sem query quando não há after/limit', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: { conversationId: 'conv-1', messages: [syntheticMessage()], nextCursor: null },
    }));
    const result = await AdminConversationApiService.getConversation('p1');
    expect(result).toEqual({ conversationId: 'conv-1', messages: [syntheticMessage()], nextCursor: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('getConversation: paginação por cursor — after/limit viram query string', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: { conversationId: 'conv-1', messages: [], nextCursor: '2026-09-02T00:00:00.000Z,uuid-2' },
    }));
    await AdminConversationApiService.getConversation('p1', { after: '2026-09-01T00:00:00.000Z,uuid-1', limit: 20 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'http://localhost:8080/api/admin/patients/p1/conversation?after=2026-09-01T00%3A00%3A00.000Z%2Cuuid-1&limit=20',
    );
  });

  it('getConversation: 403 sem célula ou paciente fora do escopo de país — ApiError tratável', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Sem acesso a este paciente', code: 'FORBIDDEN' }, 403));
    await expect(AdminConversationApiService.getConversation('p1')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(AdminConversationApiService.getConversation('p1')).rejects.toBeInstanceOf(ApiError);
  });

  it('getConversation: 404 paciente inexistente — ApiError, nunca lista vazia mentindo sucesso', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Patient not found' }, 404));
    await expect(AdminConversationApiService.getConversation('p1')).rejects.toMatchObject({ status: 404 });
  });

  // ========== 2. getConversationReplies (GET .../messages/:mid/replies) ==========

  it('getConversationReplies: GET, devolve o array de replies (desembrulha {messages})', async () => {
    const reply = syntheticMessage({ id: '22222222-2222-2222-2222-222222222222', body: 'reply-1' });
    fetchMock.mockResolvedValue(json({ success: true, data: { messages: [reply] } }));
    const result = await AdminConversationApiService.getConversationReplies('p1', 'm1');
    expect(result).toEqual([reply]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation/messages/m1/replies');
    expect(init.method).toBe('GET');
  });

  it('getConversationReplies: 400 quando :mid já é uma reply (thread de 1 nível)', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Root message is a reply', code: 'ROOT_IS_REPLY' }, 400));
    await expect(AdminConversationApiService.getConversationReplies('p1', 'm1')).rejects.toMatchObject({ status: 400, code: 'ROOT_IS_REPLY' });
  });

  it('getConversationReplies: 404 mensagem de outro paciente (nunca vaza a thread)', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Message not found' }, 404));
    await expect(AdminConversationApiService.getConversationReplies('p1', 'm1')).rejects.toMatchObject({ status: 404 });
  });

  // ========== 3. postConversationMessage (POST .../messages) ==========

  it('postConversationMessage: POST com body/rootMessageId/fileIds, devolve {id, createdAt}', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { id: 'm-new', createdAt: '2026-09-01T00:00:00.000Z' } }, 201));
    const result = await AdminConversationApiService.postConversationMessage('p1', {
      body: 'msg-1',
      rootMessageId: 'm1',
      fileIds: ['f1'],
    });
    expect(result).toEqual({ id: 'm-new', createdAt: '2026-09-01T00:00:00.000Z' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ body: 'msg-1', rootMessageId: 'm1', fileIds: ['f1'] });
  });

  it('postConversationMessage: 400 uid de menção inválido ou fileId não pertence ao autor', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Mentioned user not found', code: 'MENTIONED_USER_NOT_FOUND' }, 400));
    await expect(AdminConversationApiService.postConversationMessage('p1', { body: 'msg-1' })).rejects.toMatchObject({ status: 400, code: 'MENTIONED_USER_NOT_FOUND' });
  });

  it('postConversationMessage: 403/404 como nas demais rotas (sem célula / paciente ou rootMessageId inexistente)', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Patient not found' }, 404));
    await expect(AdminConversationApiService.postConversationMessage('p1', { body: 'msg-1' })).rejects.toMatchObject({ status: 404 });
  });

  // ========== 4. updateConversationMessage (PATCH .../messages/:mid) ==========

  it('updateConversationMessage: PATCH { body }, resolve sem valor ({success:true} sem data)', async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await expect(AdminConversationApiService.updateConversationMessage('p1', 'm1', 'msg-editada')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation/messages/m1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ body: 'msg-editada' });
  });

  it('updateConversationMessage: 403 quando quem edita não é o autor', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Not the message author', code: 'NOT_MESSAGE_AUTHOR' }, 403));
    await expect(AdminConversationApiService.updateConversationMessage('p1', 'm1', 'msg-editada')).rejects.toMatchObject({ status: 403, code: 'NOT_MESSAGE_AUTHOR' });
  });

  // ========== 5. deleteConversationMessage (DELETE .../messages/:mid) ==========

  it('deleteConversationMessage: DELETE, resolve sem valor', async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await expect(AdminConversationApiService.deleteConversationMessage('p1', 'm1')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation/messages/m1');
    expect(init.method).toBe('DELETE');
  });

  it('deleteConversationMessage: 403 quando quem apaga não é o autor (soft delete só do autor)', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Not the message author', code: 'NOT_MESSAGE_AUTHOR' }, 403));
    await expect(AdminConversationApiService.deleteConversationMessage('p1', 'm1')).rejects.toMatchObject({ status: 403, code: 'NOT_MESSAGE_AUTHOR' });
  });

  // ========== 6. markConversationRead (PUT .../read-mark) ==========

  it('markConversationRead: PUT sem body, resolve sem valor', async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await expect(AdminConversationApiService.markConversationRead('p1')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation/read-mark');
    expect(init.method).toBe('PUT');
  });

  it('markConversationRead: 403 sem a célula patient_conversation:read', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Sem acesso a este paciente', code: 'FORBIDDEN' }, 403));
    await expect(AdminConversationApiService.markConversationRead('p1')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  // ========== 6b. uploadConversationAttachment (POST .../conversation/files) — Bloco 3, T206 ==========

  it('uploadConversationAttachment: manda multipart (sem Content-Type manual), devolve fileId', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { fileId: 'file-1' } }));
    const file = new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' });

    await expect(AdminConversationApiService.uploadConversationAttachment('p1', file)).resolves.toEqual({ fileId: 'file-1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation/files');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('uploadConversationAttachment: 413 FILE_TOO_LARGE propaga code/status (D-14)', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'File too large', code: 'FILE_TOO_LARGE' }, 413));
    const file = new File(['x'], 'grande.pdf', { type: 'application/pdf' });
    await expect(AdminConversationApiService.uploadConversationAttachment('p1', file)).rejects.toMatchObject({ status: 413, code: 'FILE_TOO_LARGE' });
  });

  it('uploadConversationAttachment: 415 LEGACY_DOC_NOT_ALLOWED propaga code/status', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Legacy doc', code: 'LEGACY_DOC_NOT_ALLOWED' }, 415));
    const file = new File(['x'], 'legado.doc', { type: 'application/msword' });
    await expect(AdminConversationApiService.uploadConversationAttachment('p1', file)).rejects.toMatchObject({ status: 415, code: 'LEGACY_DOC_NOT_ALLOWED' });
  });

  // ========== 6c. getConversationAttachmentUrl (GET .../files/:fileId/url) — Bloco 3, T315 ==========

  it('getConversationAttachmentUrl: GET devolve { url, expiresInSeconds }', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { url: 'https://signed.example/x', expiresInSeconds: 300 } }));

    const result = await AdminConversationApiService.getConversationAttachmentUrl('p1', 'file-1');

    expect(result).toEqual({ url: 'https://signed.example/x', expiresInSeconds: 300 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/conversation/files/file-1/url');
    expect(init.method).toBe('GET');
  });

  it('getConversationAttachmentUrl: 404 quando o fileId não pertence à conversa deste paciente', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Not found' }, 404));
    await expect(AdminConversationApiService.getConversationAttachmentUrl('p1', 'file-de-outro')).rejects.toMatchObject({ status: 404 });
  });

  // ========== 7. searchStaffDirectory (GET /api/admin/staff-directory?q=) ==========

  it('searchStaffDirectory: GET com q codificado, devolve [{uid, displayName, isOnline}] (nunca email/role)', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [{ uid: 'staff-1', displayName: 'Fulano', isOnline: true }] }));
    const result = await AdminConversationApiService.searchStaffDirectory('ana maria');
    expect(result).toEqual([{ uid: 'staff-1', displayName: 'Fulano', isOnline: true }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/staff-directory?q=ana%20maria');
    expect(init.method).toBe('GET');
  });

  it('searchStaffDirectory: 400 quando q tem menos de 2 caracteres', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Invalid query', code: 'INVALID_QUERY' }, 400));
    await expect(AdminConversationApiService.searchStaffDirectory('a')).rejects.toMatchObject({ status: 400 });
  });

  it('searchStaffDirectory: limit (R2-B, "Mostrar todos") vira ?limit= na querystring', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [] }));
    await AdminConversationApiService.searchStaffDirectory('', 200);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/staff-directory?q=&limit=200');
  });

  it('searchStaffDirectory: sem limit, não manda o parâmetro (o controller decide o default)', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [] }));
    await AdminConversationApiService.searchStaffDirectory('ana');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/staff-directory?q=ana');
  });

  it('searchStaffDirectory: patientId (Rodada 3/R3-F, contrato novo R3-1) vira ?patientId= na querystring', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [] }));
    await AdminConversationApiService.searchStaffDirectory('ana', undefined, 'patient-1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/staff-directory?q=ana&patientId=patient-1');
  });

  it('searchStaffDirectory: sem patientId, não manda o parâmetro (comportamento de antes)', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [] }));
    await AdminConversationApiService.searchStaffDirectory('ana');
    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain('patientId');
  });

  // ========== transversal ==========

  it('sem token: nenhuma chamada manda Authorization', async () => {
    token = null;
    fetchMock.mockResolvedValue(json({ success: true, data: { conversationId: 'conv-1', messages: [], nextCursor: null } }));
    await AdminConversationApiService.getConversation('p1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
