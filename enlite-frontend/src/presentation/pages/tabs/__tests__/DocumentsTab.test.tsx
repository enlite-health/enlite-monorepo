/**
 * DocumentsTab.test.tsx
 *
 * Sem teste unitário antes desta rodada — a aba só era exercitada por e2e.
 * Fase 3 de postulacao-documento-pendente (DD4/F12) tocou este arquivo pra
 * passar `country` do store pro `DocumentsGrid` (gateia a ajuda de
 * antecedentes, trâmite argentino) — régua D200.12: arquivo no diff cobre
 * 100% INTEIRO, não só a linha nova. Cobre: loading, erro, feliz (grid +
 * seção adicional), fallback de profession, e o repasse de country.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentsTab } from '../DocumentsTab';
import { useDocumentsApi } from '@presentation/hooks/useDocumentsApi';
import { useAdditionalDocumentsApi } from '@presentation/hooks/useAdditionalDocumentsApi';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import type { WorkerDocumentsResponse, DocumentType } from '@infrastructure/http/DocumentApiService';

vi.mock('@presentation/hooks/useDocumentsApi', () => ({
  useDocumentsApi: vi.fn(),
}));

vi.mock('@presentation/hooks/useAdditionalDocumentsApi', () => ({
  useAdditionalDocumentsApi: vi.fn(),
}));

vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: vi.fn(),
}));

vi.mock('@presentation/components/organisms/DocumentsGrid', () => ({
  DocumentsGrid: ({
    documents,
    profession,
    country,
    onUpload,
    onDelete,
    onView,
  }: {
    documents: WorkerDocumentsResponse | null;
    profession?: string | null;
    country?: string | null;
    onUpload: (docType: DocumentType, file: File) => Promise<void>;
    onDelete: (docType: DocumentType) => Promise<void>;
    onView: (filePath: string) => Promise<void>;
  }) => (
    <div
      data-testid="documents-grid"
      data-documents={documents ? 'present' : 'null'}
      data-profession={profession ?? ''}
      data-country={country ?? ''}
      onClick={() => {
        onUpload('identity_document', new File(['x'], 'a.pdf'));
        onDelete('identity_document');
        onView('path/a.pdf');
      }}
    />
  ),
}));

vi.mock('@presentation/components/organisms/AdditionalDocumentsSection', () => ({
  AdditionalDocumentsSection: ({ documents }: { documents: unknown[] }) => (
    <div data-testid="additional-documents-section" data-count={documents.length} />
  ),
}));

const mockFetchDocuments = vi.fn();
const mockUploadDocument = vi.fn().mockResolvedValue(undefined);
const mockDeleteDocument = vi.fn().mockResolvedValue(undefined);
const mockViewDocument = vi.fn().mockResolvedValue(undefined);

const mockFetchAdditional = vi.fn();

function setDocumentsApi(overrides: Partial<ReturnType<typeof useDocumentsApi>> = {}): void {
  vi.mocked(useDocumentsApi).mockReturnValue({
    documents: null,
    isLoading: false,
    error: null,
    fetchDocuments: mockFetchDocuments,
    uploadDocument: mockUploadDocument,
    deleteDocument: mockDeleteDocument,
    viewDocument: mockViewDocument,
    ...overrides,
  });
}

function setAdditionalApi(overrides: Partial<ReturnType<typeof useAdditionalDocumentsApi>> = {}): void {
  vi.mocked(useAdditionalDocumentsApi).mockReturnValue({
    documents: [],
    isLoading: false,
    error: null,
    fetchDocuments: mockFetchAdditional,
    uploadDocument: vi.fn(),
    deleteDocument: vi.fn(),
    viewDocument: vi.fn(),
    ...overrides,
  });
}

function setStore(overrides: { profession?: string; country?: string } = {}): void {
  const state = {
    data: {
      generalInfo: {
        profession: overrides.profession ?? '',
        country: overrides.country ?? '',
      },
    },
  };
  vi.mocked(useWorkerRegistrationStore).mockImplementation((selector: (s: any) => any) => selector(state));
}

beforeEach(() => {
  vi.clearAllMocks();
  setAdditionalApi();
  setStore();
});

describe('DocumentsTab — carregando', () => {
  it('isLoading=true e documents=null → mostra o esqueleto, não o grid', () => {
    setDocumentsApi({ isLoading: true, documents: null });
    render(<DocumentsTab />);
    expect(screen.queryByTestId('documents-grid')).not.toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('chama fetchDocuments e fetchAdditional ao montar', () => {
    setDocumentsApi();
    render(<DocumentsTab />);
    expect(mockFetchDocuments).toHaveBeenCalledTimes(1);
    expect(mockFetchAdditional).toHaveBeenCalledTimes(1);
  });
});

describe('DocumentsTab — erro', () => {
  it('error presente e documents=null → mostra a mensagem de erro, não o grid', () => {
    setDocumentsApi({ error: 'Falha ao carregar', documents: null });
    render(<DocumentsTab />);
    expect(screen.getByText('Falha ao carregar')).toBeInTheDocument();
    expect(screen.queryByTestId('documents-grid')).not.toBeInTheDocument();
  });

  it('error presente MAS documents já veio (cache) → mostra o grid, não a tela de erro', () => {
    setDocumentsApi({ error: 'Falha ao recarregar', documents: {} as WorkerDocumentsResponse });
    render(<DocumentsTab />);
    expect(screen.getByTestId('documents-grid')).toBeInTheDocument();
    expect(screen.queryByText('Falha ao recarregar')).not.toBeInTheDocument();
  });
});

describe('DocumentsTab — feliz', () => {
  it('renderiza DocumentsGrid + AdditionalDocumentsSection com os documentos', () => {
    setDocumentsApi({ documents: {} as WorkerDocumentsResponse });
    setAdditionalApi({ documents: [{ id: '1' } as any] });
    render(<DocumentsTab />);

    const grid = screen.getByTestId('documents-grid');
    expect(grid).toHaveAttribute('data-documents', 'present');
    expect(screen.getByTestId('additional-documents-section')).toHaveAttribute('data-count', '1');
  });

  it('profession do store presente → repassada ao grid', () => {
    setDocumentsApi({ documents: {} as WorkerDocumentsResponse });
    setStore({ profession: 'AT' });
    render(<DocumentsTab />);
    expect(screen.getByTestId('documents-grid')).toHaveAttribute('data-profession', 'AT');
  });

  it('profession vazia no store (\'\') → cai no fallback null (branch `profession || null`)', () => {
    setDocumentsApi({ documents: {} as WorkerDocumentsResponse });
    setStore({ profession: '' });
    render(<DocumentsTab />);
    expect(screen.getByTestId('documents-grid')).toHaveAttribute('data-profession', '');
  });

  it('country do store (Fase 3/DD4) → repassado ao grid, pro gate de Argentina da ajuda de antecedentes', () => {
    setDocumentsApi({ documents: {} as WorkerDocumentsResponse });
    setStore({ country: 'AR' });
    render(<DocumentsTab />);
    expect(screen.getByTestId('documents-grid')).toHaveAttribute('data-country', 'AR');
  });

  it('country vazio no store (\'\', ainda não hidratado) → cai no fallback null (branch `country || null`)', () => {
    setDocumentsApi({ documents: {} as WorkerDocumentsResponse });
    setStore({ country: '' });
    render(<DocumentsTab />);
    expect(screen.getByTestId('documents-grid')).toHaveAttribute('data-country', '');
  });

  it('onUpload/onDelete/onView do grid chamam uploadDocument/deleteDocument/viewDocument do hook', () => {
    setDocumentsApi({ documents: {} as WorkerDocumentsResponse });
    render(<DocumentsTab />);
    screen.getByTestId('documents-grid').click();

    expect(mockUploadDocument).toHaveBeenCalledWith('identity_document', expect.any(File));
    expect(mockDeleteDocument).toHaveBeenCalledWith('identity_document');
    expect(mockViewDocument).toHaveBeenCalledWith('path/a.pdf');
  });
});
