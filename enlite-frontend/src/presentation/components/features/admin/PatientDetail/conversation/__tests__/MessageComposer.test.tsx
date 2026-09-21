/**
 * MessageComposer — testes unitários (spec 022, Bloco 2, T215/T216).
 *
 * Cobre:
 *   - digitar `@` + 2 caracteres dispara a busca no diretório de staff (mock) e mostra a lista;
 *   - com 1 caractere NÃO busca (o backend devolveria 400 — o front nem chama);
 *   - escolher um item da lista insere o chip visual E a string serializada (o que vai ao
 *     servidor no `body` do POST) contém `<@uid>` — a forma que o backend espera resolver;
 *   - anexar arquivo mostra o preview local (sem upload — Bloco 3);
 *   - fechar com rascunho não vazio dispara a confirmação de descarte (`useConfirmDiscardClose`);
 *   - enviar mensagem vazia é bloqueado (botão desabilitado, nenhuma chamada à API).
 *
 * `AdminConversationApiService` é mockado (T206/T207, de outro agente) — aqui só consumido pela
 * interface pública (`searchStaffDirectory`, `postConversationMessage`).
 *
 * Sem PII/texto clínico: corpo de teste é `"msg-1"`, staff é `"QA Staff Um"` (regra dura do brief).
 */
import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { AdminConversationApiService } from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { MessageComposer, type MessageComposerHandle } from '../MessageComposer';

vi.mock('@infrastructure/http/AdminConversationApiService', () => ({
  AdminConversationApiService: {
    searchStaffDirectory: vi.fn(),
    postConversationMessage: vi.fn(),
    uploadConversationAttachment: vi.fn(),
  },
}));

/** Espelha o `t` real contra o pt-BR.json de verdade — mesmo padrão de `ConversationPanel.test.tsx`. */
const translations = ptBR as Record<string, unknown>;
function resolve(key: string): unknown {
  return key.split('.').reduce((acc: any, part) => acc?.[part], translations);
}
function t(key: string, fallback?: string): string {
  const raw = resolve(key);
  return typeof raw === 'string' ? raw : (fallback ?? key);
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const PT = ptBR.admin.patients.detail.conversation.composer;
const ERR = ptBR.admin.patients.detail.conversation.errors;

const searchStaffDirectory = AdminConversationApiService.searchStaffDirectory as unknown as ReturnType<typeof vi.fn>;
const postConversationMessage = AdminConversationApiService.postConversationMessage as unknown as ReturnType<typeof vi.fn>;
const uploadConversationAttachment = AdminConversationApiService.uploadConversationAttachment as unknown as ReturnType<typeof vi.fn>;

describe('MessageComposer', () => {
  beforeEach(() => {
    searchStaffDirectory.mockReset();
    postConversationMessage.mockReset();
    uploadConversationAttachment.mockReset();
  });

  it('digitar @ + 2 caracteres dispara a busca no diretório de staff e mostra a lista', async () => {
    searchStaffDirectory.mockResolvedValue([{ uid: 'u-1', displayName: 'QA Staff Um' }]);
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, '@qa');

    await waitFor(() => expect(searchStaffDirectory).toHaveBeenCalledWith('qa'));
    await waitFor(() => expect(screen.getByTestId('composer-mention-list')).toBeInTheDocument());
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveTextContent('QA Staff Um');
  });

  it('com 1 caractere NÃO busca', async () => {
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, '@q');

    // dá tempo pra qualquer microtask pendente resolver antes de afirmar ausência.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(searchStaffDirectory).not.toHaveBeenCalled();
  });

  it('escolher um item insere o chip visual E a string serializada contém <@uid>', async () => {
    searchStaffDirectory.mockResolvedValue([{ uid: 'u-1', displayName: 'QA Staff Um' }]);
    postConversationMessage.mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' });
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, '@qa');
    await waitFor(() => expect(screen.getByTestId('composer-mention-item-u-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('composer-mention-item-u-1'));

    // Chip VISUAL: o rótulo humano aparece no DOM.
    await waitFor(() => expect(screen.getByTestId('composer-mention-chip')).toHaveTextContent('QA Staff Um'));

    fireEvent.click(screen.getByTestId('composer-send-btn'));
    await waitFor(() => expect(postConversationMessage).toHaveBeenCalledTimes(1));

    // String SERIALIZADA (o que vai pro servidor no `body`) — é ela que importa, não o DOM.
    const [, input] = postConversationMessage.mock.calls[0] as [string, { body: string }];
    expect(input.body).toContain('<@u-1>');
  });

  it('busca que falha (rede) não quebra — lista some, nenhum crash', async () => {
    searchStaffDirectory.mockRejectedValue(new Error('network'));
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, '@qa');

    await waitFor(() => expect(searchStaffDirectory).toHaveBeenCalledWith('qa'));
    expect(screen.queryByTestId('composer-mention-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-composer')).toBeInTheDocument(); // não quebrou o componente
  });

  it('Escape fecha a lista de menção sem inserir nada', async () => {
    searchStaffDirectory.mockResolvedValue([{ uid: 'u-1', displayName: 'QA Staff Um' }]);
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, '@qa');
    await waitFor(() => expect(screen.getByTestId('composer-mention-list')).toBeInTheDocument());

    fireEvent.keyDown(editor, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('composer-mention-list')).not.toBeInTheDocument());
    expect(screen.queryByTestId('composer-mention-chip')).not.toBeInTheDocument();
  });

  it('anexar arquivo dispara upload REAL (Bloco 3, T320) e mostra o chip após sucesso', async () => {
    uploadConversationAttachment.mockResolvedValue({ fileId: 'file-1' });
    render(<MessageComposer patientId="p1" />);

    const file = new File(['conteudo'], 'laudo.pdf', { type: 'application/pdf' });
    const input = screen.getByTestId('composer-attach-input');
    fireEvent.change(input, { target: { files: [file] } });

    expect(uploadConversationAttachment).toHaveBeenCalledWith('p1', file);
    await waitFor(() => expect(screen.getByText('laudo.pdf')).toBeInTheDocument());
    expect(postConversationMessage).not.toHaveBeenCalled(); // upload não é envio de mensagem
  });

  it('seletor de arquivo sem arquivo escolhido (cancelou o diálogo) não mostra nada nem sobe', () => {
    render(<MessageComposer patientId="p1" />);

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [] } });
    expect(uploadConversationAttachment).not.toHaveBeenCalled();
  });

  it('enviar mensagem com anexo já enviado inclui fileIds no POST (T320)', async () => {
    uploadConversationAttachment.mockResolvedValue({ fileId: 'file-1' });
    postConversationMessage.mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' });
    render(<MessageComposer patientId="p1" />);

    const file = new File(['conteudo'], 'laudo.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('laudo.pdf')).toBeInTheDocument());

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(postConversationMessage).toHaveBeenCalledWith('p1', {
      body: 'msg-1',
      rootMessageId: undefined,
      fileIds: ['file-1'],
    }));
  });

  it('handle.isDirty() é true com um anexo enviado, mesmo com o texto vazio', async () => {
    uploadConversationAttachment.mockResolvedValue({ fileId: 'file-1' });
    const ref = createRef<MessageComposerHandle>();
    render(<MessageComposer ref={ref} patientId="p1" />);

    expect(ref.current?.isDirty()).toBe(false);
    const file = new File(['conteudo'], 'laudo.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [file] } });

    await waitFor(() => expect(ref.current?.isDirty()).toBe(true));
  });

  it('após enviar com sucesso, chama onSent com o resultado do POST', async () => {
    const onSent = vi.fn();
    postConversationMessage.mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' });
    render(<MessageComposer patientId="p1" onSent={onSent} />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');

    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' }));
  });

  it('clique no botão de anexar abre o seletor de arquivo (input escondido)', () => {
    render(<MessageComposer patientId="p1" />);

    const input = screen.getByTestId('composer-attach-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('composer-attach-btn'));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('remover um anexo já enviado tira o chip e o exclui do próximo POST (rascunho volta a vazio)', async () => {
    uploadConversationAttachment.mockResolvedValue({ fileId: 'file-1' });
    postConversationMessage.mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' });
    render(<MessageComposer patientId="p1" />);

    const file = new File(['conteudo'], 'laudo.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('laudo.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(PT.attachments.remove));
    expect(screen.queryByText('laudo.pdf')).not.toBeInTheDocument();

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(postConversationMessage).toHaveBeenCalledWith('p1', {
      body: 'msg-1',
      rootMessageId: undefined,
      fileIds: undefined,
    }));
  });

  it('handle.isDirty() reflete o rascunho de texto', async () => {
    const ref = createRef<MessageComposerHandle>();
    render(<MessageComposer ref={ref} patientId="p1" />);

    expect(ref.current?.isDirty()).toBe(false);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');

    await waitFor(() => expect(ref.current?.isDirty()).toBe(true));
  });

  it('fechar com rascunho não vazio dispara a confirmação de descarte', async () => {
    const ref = createRef<MessageComposerHandle>();
    const onClose = vi.fn();
    render(<MessageComposer ref={ref} patientId="p1" onClose={onClose} />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');

    act(() => { ref.current?.requestClose(); });
    expect(screen.getByTestId('composer-discard-confirm')).toHaveTextContent(PT.discardConfirm);
    expect(onClose).not.toHaveBeenCalled();

    // "Cancelar" (seguir editando) — some a confirmação, o painel NÃO fecha, texto intacto.
    fireEvent.click(screen.getByTestId('composer-discard-cancel'));
    expect(screen.queryByTestId('composer-discard-confirm')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(editor).toHaveTextContent('msg-1');

    // "Descartar" — agora sim fecha (chama onClose) e o rascunho é perdido.
    act(() => { ref.current?.requestClose(); });
    fireEvent.click(screen.getByTestId('composer-discard-confirm-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fechar com rascunho VAZIO fecha direto, sem confirmação', () => {
    const ref = createRef<MessageComposerHandle>();
    const onClose = vi.fn();
    render(<MessageComposer ref={ref} patientId="p1" onClose={onClose} />);

    act(() => { ref.current?.requestClose(); });
    expect(screen.queryByTestId('composer-discard-confirm')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('🔒 achado do gate revisao-pr (B3): enviar fica DESABILITADO enquanto há upload em andamento, mesmo com texto preenchido — e volta a habilitar quando o upload termina', async () => {
    let resolveUpload: (v: { fileId: string }) => void = () => {};
    uploadConversationAttachment.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');
    expect(screen.getByTestId('composer-send-btn')).not.toBeDisabled();

    const file = new File(['conteudo'], 'laudo.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('composer-send-btn')).toBeDisabled());

    await act(async () => { resolveUpload({ fileId: 'file-1' }); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByTestId('composer-send-btn')).not.toBeDisabled());
  });

  it('🔒 achado do gate revisao-pr (B3): descartar o rascunho com upload PENDENTE remonta o picker; quando o upload órfão termina depois, o fileId NÃO vaza para a PRÓXIMA mensagem', async () => {
    let resolveUpload: (v: { fileId: string }) => void = () => {};
    uploadConversationAttachment.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    postConversationMessage.mockResolvedValue({ id: 'msg-x', createdAt: '2026-09-21T00:00:00.000Z' });
    const ref = createRef<MessageComposerHandle>();
    render(<MessageComposer ref={ref} patientId="p1" />);

    // Digita texto (torna o rascunho "dirty") + anexa um arquivo cujo upload fica PENDENTE.
    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'rascunho descartado');
    const file = new File(['conteudo'], 'laudo.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('composer-send-btn')).toBeDisabled());

    // Descarta (NÃO passa pelo botão de enviar — `requestClose` + confirmar): dispara `clearDraft`,
    // que troca a `key` do `AttachmentPicker` e o REMONTA enquanto o upload ainda está em voo.
    act(() => { ref.current?.requestClose(); });
    fireEvent.click(screen.getByTestId('composer-discard-confirm-btn'));

    // O upload "órfão" (da instância antiga, já desmontada) resolve só agora.
    resolveUpload({ fileId: 'file-tardio' });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Uma mensagem nova, sem anexo, é digitada e enviada — o fileId tardio não pode aparecer aqui.
    await user.click(editor);
    await user.type(editor, 'proxima-mensagem');
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(postConversationMessage).toHaveBeenCalledWith('p1', {
      body: 'proxima-mensagem',
      rootMessageId: undefined,
      fileIds: undefined,
    }));
  });

  it('enviar mensagem vazia é bloqueado', () => {
    render(<MessageComposer patientId="p1" />);

    const sendBtn = screen.getByTestId('composer-send-btn');
    expect(sendBtn).toBeDisabled();
    fireEvent.click(sendBtn);
    expect(postConversationMessage).not.toHaveBeenCalled();
  });

  // ---- DEFEITO 1 (conserto, gate b2-fix): POST que falha nunca mais falha em silêncio --------

  it('🔴🟢 POST que dá 403 mostra erro específico e NÃO perde o rascunho', async () => {
    postConversationMessage.mockRejectedValue(
      new ApiError({ success: false, error: 'Sem acesso', code: 'FORBIDDEN' }, 403),
    );
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');

    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(screen.getByTestId('composer-send-error')).toHaveTextContent(
      ERR.sendForbidden,
    ));
    // o rascunho NÃO se perde — a operadora não perde o que escreveu por causa do erro.
    expect(editor).toHaveTextContent('msg-1');
    expect(screen.getByTestId('composer-send-btn')).not.toBeDisabled();
  });

  it('🔴🟢 POST que dá erro genérico (não-403) mostra aviso genérico, sem perder o rascunho', async () => {
    postConversationMessage.mockRejectedValue(new Error('network down'));
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');

    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(() => expect(screen.getByTestId('composer-send-error')).toHaveTextContent(
      ERR.sendFailed,
    ));
    expect(editor).toHaveTextContent('msg-1');
  });

  it('corrigir o rascunho depois de um erro de envio esconde o aviso antigo', async () => {
    postConversationMessage.mockRejectedValueOnce(new Error('network down'));
    render(<MessageComposer patientId="p1" />);

    const editor = screen.getByTestId('composer-editor');
    const user = userEvent.setup();
    await user.click(editor);
    await user.type(editor, 'msg-1');
    fireEvent.click(screen.getByTestId('composer-send-btn'));
    await waitFor(() => expect(screen.getByTestId('composer-send-error')).toBeInTheDocument());

    await user.type(editor, ' mais texto');
    expect(screen.queryByTestId('composer-send-error')).not.toBeInTheDocument();
  });
});
