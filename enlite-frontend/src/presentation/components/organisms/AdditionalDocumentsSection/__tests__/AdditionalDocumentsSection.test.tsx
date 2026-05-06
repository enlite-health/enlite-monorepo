import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AdditionalDocumentsSection } from '../AdditionalDocumentsSection';
import type { AdditionalDocument } from '@infrastructure/http/DocumentApiService';

// ── i18n mock — returns fallback text so assertions read naturally ────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

// ── lucide-react mock — stable test-ids for icon assertions ──────────────────

vi.mock('lucide-react', () => ({
  Eye:      (props: Record<string, unknown>) => <svg data-testid="icon-eye" {...props} />,
  Trash2:   (props: Record<string, unknown>) => <svg data-testid="icon-trash" {...props} />,
  Plus:     (props: Record<string, unknown>) => <svg data-testid="icon-plus" {...props} />,
  FileText: (props: Record<string, unknown>) => <svg data-testid="icon-file-text" {...props} />,
  Loader2:  (props: Record<string, unknown>) => <svg data-testid="icon-loader" {...props} />,
}));

// ── Typography atoms mock — renders children as a plain span ─────────────────

vi.mock('@presentation/components/atoms', () => ({
  Typography: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Heading: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

// ── Shared fixtures ──────────────────────────────────────────────────────────

const mockDocs: AdditionalDocument[] = [
  {
    id: 'ad-1',
    workerId: 'w-1',
    label: 'Certificado Primeros Auxilios',
    filePath: 'workers/w-1/cert1.pdf',
    uploadedAt: '2026-04-01T00:00:00Z',
    createdAt: '2026-04-01T00:00:00Z',
  },
  {
    id: 'ad-2',
    workerId: 'w-1',
    label: 'Curso de RCP',
    filePath: 'workers/w-1/cert2.pdf',
    uploadedAt: '2026-04-02T00:00:00Z',
    createdAt: '2026-04-02T00:00:00Z',
  },
];

const noop = vi.fn().mockResolvedValue(undefined);

function buildProps(overrides: Partial<{
  documents: AdditionalDocument[];
  onUpload: (label: string, file: File) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onView: (filePath: string) => Promise<void>;
  isLoading: boolean;
}> = {}) {
  return {
    documents: [],
    onUpload: noop,
    onDelete: noop,
    onView: noop,
    isLoading: false,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(name = 'cert.pdf', type = 'application/pdf'): File {
  return new File(['content'], name, { type });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AdditionalDocumentsSection — rendering', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the section title', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    expect(screen.getByText('Otros Documentos')).toBeInTheDocument();
  });

  it('renders the add (Agregar) toggle button', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    expect(screen.getByRole('button', { name: /Agregar/i })).toBeInTheDocument();
  });

  it('renders empty-state message when no documents and not loading', () => {
    render(<AdditionalDocumentsSection {...buildProps({ documents: [] })} />);
    expect(screen.getByText('No hay documentos adicionales')).toBeInTheDocument();
  });

  it('does NOT render empty-state when documents are present', () => {
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs })} />);
    expect(screen.queryByText('No hay documentos adicionales')).not.toBeInTheDocument();
  });

  it('renders each document label from the list', () => {
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs })} />);
    expect(screen.getByText('Certificado Primeros Auxilios')).toBeInTheDocument();
    expect(screen.getByText('Curso de RCP')).toBeInTheDocument();
  });

  it('shows loading spinner (Loader2) when isLoading=true and no documents', () => {
    render(<AdditionalDocumentsSection {...buildProps({ isLoading: true, documents: [] })} />);
    expect(screen.getByTestId('icon-loader')).toBeInTheDocument();
  });

  it('shows "Cargando..." text next to spinner', () => {
    render(<AdditionalDocumentsSection {...buildProps({ isLoading: true, documents: [] })} />);
    expect(screen.getByText('Cargando...')).toBeInTheDocument();
  });

  it('does NOT show loading spinner when isLoading=true but documents are present', () => {
    render(
      <AdditionalDocumentsSection
        {...buildProps({ isLoading: true, documents: mockDocs })}
      />,
    );
    // Documents are shown — the list branch renders, not the loading branch
    expect(screen.getByText('Certificado Primeros Auxilios')).toBeInTheDocument();
    expect(screen.queryByText('Cargando...')).not.toBeInTheDocument();
  });
});

// ── Add form toggle ───────────────────────────────────────────────────────────

describe('AdditionalDocumentsSection — add form toggle', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does NOT show the form by default', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    expect(
      screen.queryByPlaceholderText('Nombre del documento (ej: Certificado Primeros Auxilios)'),
    ).not.toBeInTheDocument();
  });

  it('shows the form after clicking "Agregar"', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
    expect(
      screen.getByPlaceholderText('Nombre del documento (ej: Certificado Primeros Auxilios)'),
    ).toBeInTheDocument();
  });

  it('hides the form after clicking "Agregar" a second time (toggle off)', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    const toggle = screen.getByRole('button', { name: /Agregar/i });
    fireEvent.click(toggle); // open
    fireEvent.click(toggle); // close
    expect(
      screen.queryByPlaceholderText('Nombre del documento (ej: Certificado Primeros Auxilios)'),
    ).not.toBeInTheDocument();
  });

  it('form contains a label input', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
    expect(
      screen.getByPlaceholderText('Nombre del documento (ej: Certificado Primeros Auxilios)'),
    ).toBeInTheDocument();
  });

  it('form contains a file selector with correct accept types', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    expect(fileInput.accept).toBe('.pdf,.jpg,.jpeg,.png');
  });

  it('form shows "Seleccionar archivo" placeholder when no file chosen', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
    expect(screen.getByText('Seleccionar archivo (PDF, JPG, PNG)')).toBeInTheDocument();
  });

  it('form shows chosen file name after file selection', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile('mi-cert.pdf')] } });
    expect(screen.getByText('mi-cert.pdf')).toBeInTheDocument();
  });

  it('form contains the submit (Subir) button', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
    expect(screen.getByRole('button', { name: /Subir/i })).toBeInTheDocument();
  });
});

// ── Submit button disabled states ────────────────────────────────────────────

describe('AdditionalDocumentsSection — submit button disabled states', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function openForm() {
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
  }

  it('submit button is disabled when label is empty and no file selected', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    openForm();
    const submitBtn = screen.getByRole('button', { name: /Subir/i });
    expect(submitBtn).toBeDisabled();
  });

  it('submit button is disabled when label is filled but no file selected', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    openForm();
    const labelInput = screen.getByPlaceholderText(
      'Nombre del documento (ej: Certificado Primeros Auxilios)',
    );
    fireEvent.change(labelInput, { target: { value: 'Mi Certificado' } });
    expect(screen.getByRole('button', { name: /Subir/i })).toBeDisabled();
  });

  it('submit button is disabled when file is selected but label is empty', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    openForm();
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    expect(screen.getByRole('button', { name: /Subir/i })).toBeDisabled();
  });

  it('submit button is disabled when label is only whitespace', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    openForm();
    const labelInput = screen.getByPlaceholderText(
      'Nombre del documento (ej: Certificado Primeros Auxilios)',
    );
    fireEvent.change(labelInput, { target: { value: '   ' } });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    expect(screen.getByRole('button', { name: /Subir/i })).toBeDisabled();
  });

  it('submit button is enabled when label is filled and file is selected', () => {
    render(<AdditionalDocumentsSection {...buildProps()} />);
    openForm();
    const labelInput = screen.getByPlaceholderText(
      'Nombre del documento (ej: Certificado Primeros Auxilios)',
    );
    fireEvent.change(labelInput, { target: { value: 'Mi Certificado' } });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    expect(screen.getByRole('button', { name: /Subir/i })).not.toBeDisabled();
  });
});

// ── Document actions ──────────────────────────────────────────────────────────

describe('AdditionalDocumentsSection — document actions', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders a view (Eye icon) button for each document', () => {
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs })} />);
    const eyeIcons = screen.getAllByTestId('icon-eye');
    expect(eyeIcons).toHaveLength(mockDocs.length);
  });

  it('renders a delete (Trash icon) button for each document', () => {
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs })} />);
    const trashIcons = screen.getAllByTestId('icon-trash');
    expect(trashIcons).toHaveLength(mockDocs.length);
  });

  it('calls onView with the document filePath when view button is clicked', () => {
    const onView = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs, onView })} />);

    const viewButtons = screen.getAllByTitle('Ver');
    fireEvent.click(viewButtons[0]);

    expect(onView).toHaveBeenCalledTimes(1);
    expect(onView).toHaveBeenCalledWith(mockDocs[0].filePath);
  });

  it('calls onView with second document filePath when second view button clicked', () => {
    const onView = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs, onView })} />);

    const viewButtons = screen.getAllByTitle('Ver');
    fireEvent.click(viewButtons[1]);

    expect(onView).toHaveBeenCalledWith(mockDocs[1].filePath);
  });

  it('calls onDelete with the document id when delete button is clicked', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs, onDelete })} />);

    const deleteButtons = screen.getAllByTitle('Eliminar');
    await act(async () => { fireEvent.click(deleteButtons[0]); });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(mockDocs[0].id);
  });

  it('calls onDelete with second document id when second delete button clicked', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs, onDelete })} />);

    const deleteButtons = screen.getAllByTitle('Eliminar');
    await act(async () => { fireEvent.click(deleteButtons[1]); });

    expect(onDelete).toHaveBeenCalledWith(mockDocs[1].id);
  });

  it('disables the delete button while deletion is in progress', async () => {
    let resolveDelete!: () => void;
    const slowDelete = vi.fn().mockImplementation(
      () => new Promise<void>((res) => { resolveDelete = res; }),
    );
    render(<AdditionalDocumentsSection {...buildProps({ documents: mockDocs, onDelete: slowDelete })} />);

    const deleteButtons = screen.getAllByTitle('Eliminar');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(deleteButtons[0]).toBeDisabled();
    });

    await act(async () => { resolveDelete(); });
  });
});

// ── Upload flow ───────────────────────────────────────────────────────────────

describe('AdditionalDocumentsSection — upload flow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function openForm() {
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));
  }

  function fillForm(label: string, file: File) {
    const labelInput = screen.getByPlaceholderText(
      'Nombre del documento (ej: Certificado Primeros Auxilios)',
    );
    fireEvent.change(labelInput, { target: { value: label } });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
  }

  it('calls onUpload with trimmed label and selected file on submit', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();

    const file = makeFile('cert.pdf');
    fillForm('  Mi Certificado  ', file);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload).toHaveBeenCalledWith('Mi Certificado', file);
  });

  it('hides the form after a successful upload', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    fillForm('Mi Certificado', makeFile());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    expect(
      screen.queryByPlaceholderText('Nombre del documento (ej: Certificado Primeros Auxilios)'),
    ).not.toBeInTheDocument();
  });

  it('clears the label input after a successful upload', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    fillForm('Mi Certificado', makeFile());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    // Re-open the form: label should be empty
    openForm();
    const labelInput = screen.getByPlaceholderText(
      'Nombre del documento (ej: Certificado Primeros Auxilios)',
    ) as HTMLInputElement;
    expect(labelInput.value).toBe('');
  });

  it('shows file placeholder again after a successful upload (file cleared)', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    fillForm('Mi Certificado', makeFile('cert.pdf'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    // Re-open the form: file label should reset to placeholder
    openForm();
    expect(screen.getByText('Seleccionar archivo (PDF, JPG, PNG)')).toBeInTheDocument();
  });

  it('shows an error message when onUpload rejects', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('Error de red'));
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    fillForm('Mi Certificado', makeFile());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Error de red')).toBeInTheDocument();
    });
  });

  it('shows "Error" fallback when rejected value is not an Error instance', async () => {
    const onUpload = vi.fn().mockRejectedValue('unexpected string rejection');
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    fillForm('Mi Certificado', makeFile());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  it('keeps the form open after a failed upload so the user can retry', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('Fallo'));
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    fillForm('Mi Certificado', makeFile());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('Nombre del documento (ej: Certificado Primeros Auxilios)'),
      ).toBeInTheDocument();
    });
  });

  it('error message is hidden when form is toggled closed (error leaves DOM with form)', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('Fallo'));
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    fillForm('Mi Certificado', makeFile());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    });

    await waitFor(() => expect(screen.getByText('Fallo')).toBeInTheDocument());

    // Toggling the form closed unmounts the form element, so the error is no longer visible
    const toggle = screen.getByRole('button', { name: /Agregar/i });
    fireEvent.click(toggle); // close

    expect(screen.queryByText('Fallo')).not.toBeInTheDocument();
  });

  it('does not call onUpload when submit button is clicked while disabled', () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<AdditionalDocumentsSection {...buildProps({ onUpload })} />);
    openForm();
    // Do NOT fill the form — button stays disabled
    fireEvent.click(screen.getByRole('button', { name: /Subir/i }));
    expect(onUpload).not.toHaveBeenCalled();
  });
});
