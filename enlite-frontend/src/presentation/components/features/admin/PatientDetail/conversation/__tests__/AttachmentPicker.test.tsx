/**
 * AttachmentPicker — testes unitários (spec 022, Bloco 3, T318/T319).
 *
 * Cobre:
 *   - `accept` do input restrito às extensões de D-14 (`.pdf,.png,.jpg,.jpeg,.docx`);
 *   - validação de TAMANHO no cliente (10 MB, D-14) ANTES de qualquer upload — arquivo grande
 *     nunca chama `uploadConversationAttachment`;
 *   - arquivo válido dispara upload real (`AdminConversationApiService.uploadConversationAttachment`)
 *     e, após sucesso, mostra o chip + chama `onUploaded(fileId)`;
 *   - erro do servidor (413/415/`LEGACY_DOC_NOT_ALLOWED`) aparece via i18n (ES/PT já existem, T124);
 *   - máximo de 5 anexos: o 6º fica bloqueado (botão desabilitado + aviso), sem chamar upload;
 *   - remover um anexo JÁ enviado chama `onRemoved(fileId)` e libera 1 vaga.
 *
 * `AdminConversationApiService` mockado — só a interface pública é exercitada.
 * Sem PII/texto clínico: nomes de arquivo são sintéticos (regra dura do brief).
 */
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { AdminConversationApiService } from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { AttachmentPicker } from '../AttachmentPicker';

vi.mock('@infrastructure/http/AdminConversationApiService', () => ({
  AdminConversationApiService: {
    uploadConversationAttachment: vi.fn(),
  },
}));

const translations = ptBR as Record<string, unknown>;
function resolve(key: string): unknown {
  return key.split('.').reduce((acc: any, part) => acc?.[part], translations);
}
function t(key: string, fallback?: string): string {
  const raw = resolve(key);
  return typeof raw === 'string' ? raw : (fallback ?? key);
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const ERR = ptBR.admin.patients.detail.conversation.errors;
const CP = ptBR.admin.patients.detail.conversation.composer;

const uploadConversationAttachment = AdminConversationApiService.uploadConversationAttachment as unknown as ReturnType<typeof vi.fn>;

function pdf(name = 'doc.pdf', sizeBytes?: number): File {
  const file = new File(['%PDF-1.4'], name, { type: 'application/pdf' });
  if (sizeBytes !== undefined) Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

describe('AttachmentPicker', () => {
  beforeEach(() => {
    uploadConversationAttachment.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('input aceita só as extensões de D-14', () => {
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);
    expect(screen.getByTestId('composer-attach-input')).toHaveAttribute('accept', '.pdf,.png,.jpg,.jpeg,.docx');
  });

  it('arquivo acima de 10 MB: mostra erro de tamanho SEM chamar upload (validação no cliente, D-14)', async () => {
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);

    const grande = pdf('grande.pdf', 10 * 1024 * 1024 + 1);
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [grande] } });

    await waitFor(() => expect(screen.getByText(ERR.fileTooLarge)).toBeInTheDocument());
    expect(uploadConversationAttachment).not.toHaveBeenCalled();
  });

  it('arquivo válido: sobe de verdade e mostra o chip após sucesso, chama onUploaded(fileId)', async () => {
    uploadConversationAttachment.mockResolvedValue({ fileId: 'file-1' });
    const onUploaded = vi.fn();
    render(<AttachmentPicker patientId="p1" onUploaded={onUploaded} />);

    const file = pdf('laudo.pdf');
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [file] } });

    expect(uploadConversationAttachment).toHaveBeenCalledWith('p1', file);
    await waitFor(() => expect(screen.getByText('laudo.pdf')).toBeInTheDocument());
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('file-1'));
  });

  it('arquivo PNG/JPEG/.docx: sobe normalmente, chip aparece com o nome (ícone varia por content-type)', async () => {
    uploadConversationAttachment.mockImplementation(async (_p: string, file: File) => ({ fileId: `file-${file.name}` }));
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);
    const input = screen.getByTestId('composer-attach-input');

    const png = new File(['x'], 'foto.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() => expect(screen.getByText('foto.png')).toBeInTheDocument());

    const docx = new File(['x'], 'relatorio.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    fireEvent.change(input, { target: { files: [docx] } });
    await waitFor(() => expect(screen.getByText('relatorio.docx')).toBeInTheDocument());
  });

  it('seletor sem arquivo escolhido (cancelou o diálogo) não mostra nada', () => {
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);
    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [] } });
    expect(screen.queryByTestId('attachment-picker-list')).not.toBeInTheDocument();
  });

  it('erro 413 FILE_TOO_LARGE do servidor mostra o mesmo texto i18n do limite de tamanho', async () => {
    uploadConversationAttachment.mockRejectedValue(
      new ApiError({ success: false, error: 'too large', code: 'FILE_TOO_LARGE' }, 413),
    );
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });

    await waitFor(() => expect(screen.getByText(ERR.fileTooLarge)).toBeInTheDocument());
  });

  it('erro 415 UNSUPPORTED_MEDIA_TYPE mostra o texto i18n correspondente', async () => {
    uploadConversationAttachment.mockRejectedValue(
      new ApiError({ success: false, error: 'unsupported', code: 'UNSUPPORTED_MEDIA_TYPE' }, 415),
    );
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });

    await waitFor(() => expect(screen.getByText(ERR.unsupportedType)).toBeInTheDocument());
  });

  it('erro 415 LEGACY_DOC_NOT_ALLOWED mostra o texto i18n específico do .doc legado', async () => {
    uploadConversationAttachment.mockRejectedValue(
      new ApiError({ success: false, error: 'legacy', code: 'LEGACY_DOC_NOT_ALLOWED' }, 415),
    );
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf('legado.doc')] } });

    await waitFor(() => expect(screen.getByText(ERR.legacyDoc)).toBeInTheDocument());
  });

  it('erro 415 MALICIOUS_CONTENT_DETECTED mostra o texto i18n correspondente', async () => {
    uploadConversationAttachment.mockRejectedValue(
      new ApiError({ success: false, error: 'malicious', code: 'MALICIOUS_CONTENT_DETECTED' }, 415),
    );
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });

    await waitFor(() => expect(screen.getByText(ERR.maliciousContent)).toBeInTheDocument());
  });

  it('erro genérico (rede) mostra o aviso genérico de upload', async () => {
    uploadConversationAttachment.mockRejectedValue(new Error('network down'));
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });

    await waitFor(() => expect(screen.getByText(ERR.uploadFailed)).toBeInTheDocument());
  });

  it('máximo de 5 anexos: o botão de anexar fica desabilitado no 5º sucesso, e mostra o aviso', async () => {
    uploadConversationAttachment.mockImplementation(async (_p: string, file: File) => ({ fileId: `file-${file.name}` }));
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} />);

    const input = screen.getByTestId('composer-attach-input');
    for (let i = 1; i <= 5; i += 1) {
      fireEvent.change(input, { target: { files: [pdf(`doc-${i}.pdf`)] } });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.getByText(`doc-${i}.pdf`)).toBeInTheDocument());
    }

    expect(screen.getByTestId('composer-attach-btn')).toBeDisabled();
    expect(screen.getByText(CP.attachments.max)).toBeInTheDocument();
    expect(uploadConversationAttachment).toHaveBeenCalledTimes(5);
  });

  it('remover um anexo já enviado chama onRemoved(fileId) e libera 1 vaga (desbloqueia o botão)', async () => {
    uploadConversationAttachment.mockImplementation(async (_p: string, file: File) => ({ fileId: `file-${file.name}` }));
    const onRemoved = vi.fn();
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} onRemoved={onRemoved} />);

    const input = screen.getByTestId('composer-attach-input');
    for (let i = 1; i <= 5; i += 1) {
      fireEvent.change(input, { target: { files: [pdf(`doc-${i}.pdf`)] } });
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.getByText(`doc-${i}.pdf`)).toBeInTheDocument());
    }
    expect(screen.getByTestId('composer-attach-btn')).toBeDisabled();

    const removeButtons = screen.getAllByLabelText(CP.attachments.remove);
    fireEvent.click(removeButtons[0]);

    expect(onRemoved).toHaveBeenCalledWith('file-doc-1.pdf');
    expect(screen.queryByText('doc-1.pdf')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('composer-attach-btn')).not.toBeDisabled());
  });

  it('🔒 achado de limpeza do gate revisao-pr (B3): em StrictMode (React invoca o updater do setItems 2× de propósito em dev), remover um anexo chama onRemoved EXATAMENTE 1 vez — o efeito colateral não pode morar dentro do updater', async () => {
    uploadConversationAttachment.mockResolvedValue({ fileId: 'file-1' });
    const onRemoved = vi.fn();
    render(
      <StrictMode>
        <AttachmentPicker patientId="p1" onUploaded={vi.fn()} onRemoved={onRemoved} />
      </StrictMode>,
    );

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });
    await waitFor(() => expect(screen.getByText('doc.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Remover anexo'));

    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith('file-1');
  });

  it('reporta onUploadingChange(true) enquanto o upload está pendente e (false) quando termina', async () => {
    let resolveUpload: (v: { fileId: string }) => void = () => {};
    uploadConversationAttachment.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const onUploadingChange = vi.fn();
    render(<AttachmentPicker patientId="p1" onUploaded={vi.fn()} onUploadingChange={onUploadingChange} />);

    expect(onUploadingChange).toHaveBeenCalledWith(false); // estado inicial: sem itens

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(true));

    resolveUpload({ fileId: 'file-1' });
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false));
  });

  it('🔒 achado do gate revisao-pr (B3): desmontar (troca de `key`, ex.: `clearDraft` do MessageComposer) ANTES de um upload pendente resolver — o upload órfão NÃO chama onUploaded/onUploadingChange depois, nem loga aviso de "state update on unmounted component"', async () => {
    let resolveUpload: (v: { fileId: string }) => void = () => {};
    uploadConversationAttachment.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const onUploaded = vi.fn();
    const onUploadingChange = vi.fn();
    const { unmount } = render(
      <AttachmentPicker patientId="p1" onUploaded={onUploaded} onUploadingChange={onUploadingChange} />,
    );

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });
    await waitFor(() => expect(uploadConversationAttachment).toHaveBeenCalledTimes(1));

    unmount(); // equivalente a trocar a `key` no pai — instância antiga desmontada com upload em voo
    onUploaded.mockClear();
    onUploadingChange.mockClear();

    resolveUpload({ fileId: 'file-orfao' });
    await new Promise((r) => setTimeout(r, 0));

    expect(onUploaded).not.toHaveBeenCalled();
    expect(onUploadingChange).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('unmounted component'));
  });

  it('🔒 mesma guarda de desmontagem, agora no caminho de ERRO: upload órfão que REJEITA depois de desmontado não seta estado nem loga aviso', async () => {
    let rejectUpload: (err: unknown) => void = () => {};
    uploadConversationAttachment.mockImplementation(() => new Promise((_resolve, reject) => { rejectUpload = reject; }));
    const onUploadingChange = vi.fn();
    const { unmount } = render(
      <AttachmentPicker patientId="p1" onUploaded={vi.fn()} onUploadingChange={onUploadingChange} />,
    );

    fireEvent.change(screen.getByTestId('composer-attach-input'), { target: { files: [pdf()] } });
    await waitFor(() => expect(uploadConversationAttachment).toHaveBeenCalledTimes(1));

    unmount();
    onUploadingChange.mockClear();

    rejectUpload(new Error('network down'));
    await new Promise((r) => setTimeout(r, 0));

    expect(onUploadingChange).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('unmounted component'));
  });
});
