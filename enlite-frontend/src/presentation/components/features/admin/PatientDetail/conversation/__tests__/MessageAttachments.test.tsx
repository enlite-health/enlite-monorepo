/**
 * MessageAttachments — testes unitários (ajustes de UI B5, spec 022; gate 21/09, achado A1).
 *
 * Cobre:
 *   - PDF/DOCX: chip com nome (truncado + `title`) + tamanho legível ("1 KB");
 *   - IMAGEM (png/jpeg): miniatura só carrega depois que o `IntersectionObserver` reporta
 *     visibilidade — via `<img src={signedUrl}>` DIRETO (achado A1 do gate: o bucket de
 *     produção `enlite-patient-documents` não tem CORS configurado de propósito — `fetch(url)`
 *     cross-origin quebra em prd, mas um `<img>` como subresource NÃO exige CORS);
 *   - erro de rede/expiração no `<img>` (evento `onError`) faz UMA tentativa de renovar a signed
 *     URL antes de desistir e mostrar o estado de erro.
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
    // 🔒 espião de `fetch` global — nenhum teste deste arquivo deve fazer o componente chamá-lo
    // pra baixar bytes de imagem (achado A1 do gate: isso é exatamente o que quebra em prd, bucket
    // sem CORS). Fica de sentinela em TODOS os testes, não só nos de imagem.
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
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

  describe('IMAGEM — miniatura lazy (IntersectionObserver + <img src={signedUrl}> direto, achado A1)', () => {
    it('NÃO chama a API antes de ficar visível', () => {
      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      expect(getConversationAttachmentUrl).not.toHaveBeenCalled();
      expect(screen.queryByTestId('message-attachment-image-file-img')).not.toBeInTheDocument();
    });

    it('fica visível → busca a signed URL → <img src> É a signed URL, SEM fetch() dos bytes (bucket de prd não tem CORS — achado A1)', async () => {
      getConversationAttachmentUrl.mockResolvedValue({ url: 'https://signed.example/img', expiresInSeconds: 300 });

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);

      await waitFor(() => expect(getConversationAttachmentUrl).toHaveBeenCalledWith('p1', 'file-img'));
      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());

      const img = screen.getByTestId('message-attachment-image-file-img') as HTMLImageElement;
      expect(img.src).toBe('https://signed.example/img');
      // 🔒 a prova negativa do achado A1: nenhum `fetch` pros bytes da imagem. `<img src>` é uma
      // carga de subresource do PRÓPRIO browser (fora do `fetch` do app), que não exige CORS —
      // é exatamente por isso que troca o approach antigo (`fetch→blob→objectURL`, que exigia).
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('nome do arquivo aparece embaixo da miniatura', async () => {
      getConversationAttachmentUrl.mockResolvedValue({ url: 'https://signed.example/img', expiresInSeconds: 300 });

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);

      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());
      expect(screen.getByTestId('message-attachment-file-img')).toHaveTextContent('foto-ferida.png');
    });

    it('erro ao buscar a signed URL (API) não quebra a tela — mostra estado de erro', async () => {
      getConversationAttachmentUrl.mockRejectedValue(new Error('network down'));

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);

      await waitFor(() => expect(screen.getByTestId('message-attachment-file-img')).toBeInTheDocument());
      expect(screen.queryByTestId('message-attachment-image-file-img')).not.toBeInTheDocument();
    });

    it('`onError` do <img> (ex.: signed URL expirada, TTL 300s) pede UMA URL nova antes de desistir', async () => {
      getConversationAttachmentUrl
        .mockResolvedValueOnce({ url: 'https://signed.example/img-velha', expiresInSeconds: 300 })
        .mockResolvedValueOnce({ url: 'https://signed.example/img-nova', expiresInSeconds: 300 });

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);

      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());
      expect((screen.getByTestId('message-attachment-image-file-img') as HTMLImageElement).src).toBe('https://signed.example/img-velha');

      fireEvent.error(screen.getByTestId('message-attachment-image-file-img'));

      await waitFor(() => expect(getConversationAttachmentUrl).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect((screen.getByTestId('message-attachment-image-file-img') as HTMLImageElement).src).toBe('https://signed.example/img-nova'),
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('segundo `onError` (a URL renovada TAMBÉM falha) desiste e mostra o estado de erro', async () => {
      getConversationAttachmentUrl.mockResolvedValue({ url: 'https://signed.example/img', expiresInSeconds: 300 });

      render(<MessageAttachments patientId="p1" attachments={[imageAttachment]} />);
      triggerIntersect(true);
      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());

      fireEvent.error(screen.getByTestId('message-attachment-image-file-img'));
      await waitFor(() => expect(getConversationAttachmentUrl).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId('message-attachment-image-file-img')).toBeInTheDocument());

      fireEvent.error(screen.getByTestId('message-attachment-image-file-img'));

      await waitFor(() => expect(screen.queryByTestId('message-attachment-image-file-img')).not.toBeInTheDocument());
      expect(screen.getByTestId('message-attachment-file-img')).toHaveTextContent(
        'Não conseguimos baixar o arquivo. Tente de novo.',
      );
    });
  });
});
