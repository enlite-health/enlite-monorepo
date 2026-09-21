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
  body: 'msg-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  mentions: [],
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

  // ========== 7. searchStaffDirectory (GET /api/admin/staff-directory?q=) ==========

  it('searchStaffDirectory: GET com q codificado, devolve [{uid, displayName}] (nunca email/role)', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [{ uid: 'staff-1', displayName: 'Fulano' }] }));
    const result = await AdminConversationApiService.searchStaffDirectory('ana maria');
    expect(result).toEqual([{ uid: 'staff-1', displayName: 'Fulano' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/staff-directory?q=ana%20maria');
    expect(init.method).toBe('GET');
  });

  it('searchStaffDirectory: 400 quando q tem menos de 2 caracteres', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Invalid query', code: 'INVALID_QUERY' }, 400));
    await expect(AdminConversationApiService.searchStaffDirectory('a')).rejects.toMatchObject({ status: 400 });
  });

  // ========== transversal ==========

  it('sem token: nenhuma chamada manda Authorization', async () => {
    token = null;
    fetchMock.mockResolvedValue(json({ success: true, data: { conversationId: 'conv-1', messages: [], nextCursor: null } }));
    await AdminConversationApiService.getConversation('p1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
