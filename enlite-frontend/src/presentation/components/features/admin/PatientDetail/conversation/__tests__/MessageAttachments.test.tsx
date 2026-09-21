/**
 * MessageAttachments — testes unitários (ajustes de UI B5, spec 022).
 *
 * Cobre:
 *   - PDF/DOCX: chip com nome (truncado + `title`) + tamanho legível ("1 KB");
 *   - IMAGEM (png/jpeg): miniatura só carrega depois que o `IntersectionObserver` reporta
 *     visibilidade — via `fetch` → `blob` → `URL.createObjectURL` (nunca `<img src={signedUrl}>` cru);
 *   - erro no fetch da imagem não quebra a tela (mostra estado de erro, sem crash);
 *   - `URL.revokeObjectURL` é chamado no unmount (sem vazar blob).
 *
 * `IntersectionObserver` não existe em jsdom — mock mínimo neste arquivo, controlado pelo teste
 * (dispara `isIntersecting` manualmente), documentado aqui em vez de no setup global (raio de
 * impacto do mock fica só neste arquivo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { AdminConversationApiService, type ConversationMessageAttachment } from '@infrastructure/http/AdminConversationApiService';
import { MessageAttachments } from '../MessageAttachments';

vi.mock('@infrastructure/http/AdminConversationApiService', () => ({
  AdminConversationApiService: {
    getConversationAttachmentUrl: vi.fn(),
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

const getConversationAttachmentUrl = AdminConversationApiService.getConversationAttachmentUrl as unknown as ReturnType<typeof vi.fn>;

/** Mock controlável: o teste dispara `triggerIntersect()` para simular "card ficou visível". */
let intersectCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
let disconnectSpy: ReturnType<typeof vi.fn>;

class FakeIntersectionObserver {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    intersectCallback = cb;
  }

  observe = vi.fn();
  disconnect = disconnectSpy;
  unobserve = vi.fn();
}

function triggerIntersect(isIntersecting: boolean): void {
  intersectCallback?.([{ isIntersecting }]);
}

const pdfAttachment: ConversationMessageAttachment = {
  fileId: 'file-pdf', contentType: 'application/pdf', sizeBytes: 1024, originalName: 'receita-medica-set-2026.pdf',
};
const imageAttachment: ConversationMessageAttachment = {
  fileId: 'file-img', contentType: 'image/png', sizeBytes: 2048, originalName: 'foto-ferida.png',
};

describe('MessageAttachments', () => {
  beforeEach(() => {
    getConversationAttachmentUrl.mockReset();
    disconnectSpy = vi.fn();
    intersectCallback = null;
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver);
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake-url'), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    // `cleanup()` EXPLÍCITO antes de tirar os stubs — a limpeza automática do testing-library
    // (registrada em `afterEach` no import de `@testing-library/react`) pode rodar DEPOIS deste
    // hook (ordem entre múltiplos `afterEach` não é garantida entre escopos), e o jsdom NÃO
    // implementa `URL.revokeObjectURL` nativamente — desmontar com o stub já removido quebrava
    // o cleanup do `ImageAttachment` (achado medido nesta sessão).
    cleanup();
    vi.unstubAllGlobals();
  });

  describe('PDF/DOCX — chip com nome truncado + tamanho', () => {
    it('mostra o nome original (title com o nome completo) e o tamanho legível', () => {
      render(<MessageAttachments patientId="p1" attachments={[pdfAttachment]} />);
      const chip = screen.getByTestId('message-attachment-file-pdf');
      expect(chip).toHaveAttribute('title', 'receita-medica-set-2026.pdf');
      expect(chip).toHaveTextContent('receita-medica-set-2026.pdf');
      expect(chip).toHaveTextContent('1 KB');
    });

    it('clique baixa (mesmo comportamento de sempre — abre aba síncrona)', () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue({ opener: null, location: { href: '' }, closed: false, close: vi.fn() } as unknown as Window);
      render(<MessageAttachments patientId="p1" attachments={[pdfAttachment]} />);
      fireEvent.click(screen.getByTestId('message-attachment-file-pdf'));
      expect(openSpy).toHaveBeenCalledWith('', '_blank');
      openSpy.mockRestore();
    });

    it('🔒 achado do gate visual (ajustes de UI B5, rodada 2): o chip é COMPACTO — nunca uma caixa alta de miniatura. Sem a estrutura de imagem (sem `relative group`, sem `h-24`/`max-h-40`) e mora numa lista PRÓPRIA (`message-attachments-files`), nunca no mesmo flex-row de uma miniatura (senão o flexbox estica o botão pra altura da imagem — a causa raiz medida)', () => {
      render(<MessageAttachments patientId="p1" attachments={[pdfAttachment]} />);
      const chip = screen.getByTestId('message-attachment-file-pdf');
      // nunca contém a marcação de moldura de miniatura (achado: h-24/max-h-40 são exclusivos de ImageAttachment)
      expect(chip.innerHTML).not.toContain('h-24');
      expect(chip.innerHTML).not.toContain('max-h-40');
      expect(chip.querySelector('img')).not.toBeInTheDocument();
      // vive na lista de arquivos, NUNCA na grade de imagens (containers separados — a causa raiz do "caixa alta e vazia" era os dois no MESMO flex-wrap, que estica o item curto pra altura do mais alto)
      const filesList = screen.getByTestId('message-attachments-files');
      expect(filesList).toContainElement(chip);
      expect(screen.queryByTestId('message-attachments-images')).not.toBeInTheDocument();
    });
  });

  describe('imagens e arquivos em containers SEPARADOS (achado do gate visual, rodada 2)', () => {
    it('mensagem com imagem + PDF: grade de imagens e lista de arquivos são elementos DIFERENTES (nunca o mesmo flex-wrap)', () => {
      render(<MessageAttachments patientId="p1" attachments={[imageAttachment, pdfAttachment]} />);
      const imagesGrid = screen.getByTestId('message-attachments-images');
      const filesList = screen.getByTestId('message-attachments-files');
      expect(imagesGrid).not.toBe(filesList);
      expect(imagesGrid).toContainElement(screen.getByTestId('message-attachment-file-img'));
      expect(filesList).toContainElement(screen.getByTestId('message-attachment-file-pdf'));
    });

    it('só imagem: não renderiza a lista de arquivos (nenhum container vazio à toa)', () => {
      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      expect(screen.getByTestId('message-attachments-images')).toBeInTheDocument();
      expect(screen.queryByTestId('message-attachments-files')).not.toBeInTheDocument();
    });
  });

  describe('IMAGEM — miniatura lazy (IntersectionObserver + fetch→blob→objectURL)', () => {
    it('NÃO chama a API antes de ficar visível', () => {
      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      expect(getConversationAttachmentUrl).not.toHaveBeenCalled();
      expect(screen.queryByTestId('message-attachment-image-file-img')).not.toBeInTheDocument();
    });

    it('fica visível → busca a signed URL → fetch → blob → <img> com objectURL (nunca a signed URL crua no src)', async () => {
      getConversationAttachmentUrl.mockResolvedValue({ url: 'https://signed.example/img', expiresInSeconds: 300 });
      const fakeBlob = new Blob(['x']);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ blob: async () => fakeBlob });

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);

      await waitFor(() => expect(getConversationAttachmentUrl).toHaveBeenCalledWith('p1', 'file-img'));
      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('https://signed.example/img'));
      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());

      const img = screen.getByTestId('message-attachment-image-file-img') as HTMLImageElement;
      expect(img.src).toBe('blob:fake-url');
      expect(img.src).not.toContain('signed.example'); // nunca a signed URL crua no DOM
    });

    it('nome do arquivo aparece embaixo da miniatura', async () => {
      getConversationAttachmentUrl.mockResolvedValue({ url: 'https://signed.example/img', expiresInSeconds: 300 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ blob: async () => new Blob(['x']) });

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);

      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());
      expect(screen.getByTestId('message-attachment-file-img')).toHaveTextContent('foto-ferida.png');
    });

    it('erro no fetch da imagem não quebra a tela — mostra estado de erro', async () => {
      getConversationAttachmentUrl.mockRejectedValue(new Error('network down'));

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);

      await waitFor(() => expect(screen.getByTestId('message-attachment-file-img')).toBeInTheDocument());
      expect(screen.queryByTestId('message-attachment-image-file-img')).not.toBeInTheDocument();
    });

    it('unmount revoga o objectURL (sem vazar blob)', async () => {
      getConversationAttachmentUrl.mockResolvedValue({ url: 'https://signed.example/img', expiresInSeconds: 300 });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ blob: async () => new Blob(['x']) });

      const { unmount } = render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);
      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());

      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    });
  });
});
