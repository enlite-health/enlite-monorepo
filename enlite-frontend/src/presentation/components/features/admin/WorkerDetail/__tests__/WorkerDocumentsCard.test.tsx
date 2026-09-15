import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkerDocumentsCard } from '../WorkerDocumentsCard';
import type { WorkerDocument, DocumentValidations } from '@domain/entities/Worker';
import type { AdminDocumentType } from '@hooks/admin/useAdminWorkerDocuments';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

const noopUpload = vi.fn().mockResolvedValue(undefined);
const noopDelete = vi.fn().mockResolvedValue(undefined);
const noopView = vi.fn().mockResolvedValue(undefined);
const noopValidate = vi.fn().mockResolvedValue(undefined);
const noopInvalidate = vi.fn().mockResolvedValue(undefined);

const defaultHandlers = {
  profession: null,
  onUpload: noopUpload,
  onDelete: noopDelete,
  onView: noopView,
  onValidate: noopValidate,
  onInvalidate: noopInvalidate,
  loadingTypes: new Set<AdminDocumentType>(),
  errors: {},
};

const fullDoc: WorkerDocument = {
  id: 'doc-1',
  resumeCvUrl: 'https://storage.example.com/cv.pdf',
  identityDocumentUrl: 'https://storage.example.com/id.pdf',
  identityDocumentBackUrl: null,
  criminalRecordUrl: 'https://storage.example.com/criminal.pdf',
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  cartaRecomendacionUrl: null,
  additionalCertificatesUrls: ['https://storage.example.com/cert1.pdf'],
  documentsStatus: 'approved',
  reviewNotes: 'Tudo verificado.',
  reviewedBy: 'admin-1',
  reviewedAt: '2026-03-15T00:00:00Z',
  submittedAt: '2026-03-10T00:00:00Z',
};

describe('WorkerDocumentsCard', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  // ── i18n labels ────────────────────────────────────────────────────────────

  it('renders card title using i18n key admin.workerDetail.documents', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    expect(screen.getByText('admin.workerDetail.documents')).toBeInTheDocument();
  });

  it('renders title even when documents is null', () => {
    render(<WorkerDocumentsCard documents={null} {...defaultHandlers} />);
    expect(screen.getByText('admin.workerDetail.documents')).toBeInTheDocument();
  });

  it('renders document cards even when documents is null', () => {
    render(<WorkerDocumentsCard documents={null} {...defaultHandlers} />);
    expect(screen.getByText('documentTypes.resume_cv')).toBeInTheDocument();
    expect(screen.getByText('documentTypes.identity_document')).toBeInTheDocument();
  });

  it('renders universal document labels for non-AT profession', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    expect(screen.getByText('documentTypes.resume_cv')).toBeInTheDocument();
    expect(screen.getByText('documentTypes.identity_document')).toBeInTheDocument();
    expect(screen.getByText('documentTypes.criminal_record')).toBeInTheDocument();
    expect(screen.getByText('documentTypes.liability_insurance')).toBeInTheDocument();
    expect(screen.getByText('documentTypes.monotributo_certificate')).toBeInTheDocument();
  });

  // ── ABAC: professional_registration oculto ────────────────────────────────

  it('never renders professional_registration slot (ABAC policy: hidden for all profiles)', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    expect(screen.queryByText('documentTypes.professional_registration')).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid="doc-slot-professional_registration"]')).toBeNull();
  });

  it('never renders professional_registration slot even for AT profession', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    expect(screen.queryByText('documentTypes.professional_registration')).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid="doc-slot-professional_registration"]')).toBeNull();
  });

  // ── ABAC: monotributo_certificate universal ───────────────────────────────

  it('renders monotributo_certificate for non-AT (universal slot)', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession={null} />);
    expect(screen.getByText('documentTypes.monotributo_certificate')).toBeInTheDocument();
  });

  it('renders monotributo_certificate for AT (universal slot)', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    expect(screen.getByText('documentTypes.monotributo_certificate')).toBeInTheDocument();
  });

  // ── ABAC: atOnly slots ────────────────────────────────────────────────────

  it('shows AT-only slots (at_certificate, apto_psicofisico, analitico_universitario) when profession is AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    expect(screen.getByText('documentTypes.at_certificate')).toBeInTheDocument();
    expect(screen.getByText('documentTypes.apto_psicofisico')).toBeInTheDocument();
    expect(screen.getByText('documentTypes.analitico_universitario')).toBeInTheDocument();
  });

  it('hides AT-only slots when profession is null', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession={null} />);
    expect(screen.queryByText('documentTypes.at_certificate')).not.toBeInTheDocument();
    expect(screen.queryByText('documentTypes.apto_psicofisico')).not.toBeInTheDocument();
    expect(screen.queryByText('documentTypes.analitico_universitario')).not.toBeInTheDocument();
  });

  it('hides AT-only slots when profession is CUIDADOR', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="CUIDADOR" />);
    expect(screen.queryByText('documentTypes.at_certificate')).not.toBeInTheDocument();
    expect(screen.queryByText('documentTypes.apto_psicofisico')).not.toBeInTheDocument();
    expect(screen.queryByText('documentTypes.analitico_universitario')).not.toBeInTheDocument();
  });

  // ── ABAC: cuidadorOnly slots ──────────────────────────────────────────────

  it('shows carta_recomendacion for non-AT (Cuidador)', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="CUIDADOR" />);
    expect(screen.getByText('documentTypes.carta_recomendacion')).toBeInTheDocument();
  });

  it('shows carta_recomendacion for null profession (treated as non-AT)', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession={null} />);
    expect(screen.getByText('documentTypes.carta_recomendacion')).toBeInTheDocument();
  });

  it('hides carta_recomendacion for AT profession', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    expect(screen.queryByText('documentTypes.carta_recomendacion')).not.toBeInTheDocument();
  });

  // ── AT warning banner ─────────────────────────────────────────────────────

  it('shows AT warning banner when profession is AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    expect(screen.getByText('documents.atRequiredWarning')).toBeInTheDocument();
  });

  it('hides AT warning banner when profession is not AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="CUIDADOR" />);
    expect(screen.queryByText('documents.atRequiredWarning')).not.toBeInTheDocument();
  });

  it('hides AT warning banner when profession is null', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession={null} />);
    expect(screen.queryByText('documents.atRequiredWarning')).not.toBeInTheDocument();
  });

  // ── Status badges ──────────────────────────────────────────────────────────

  it('renders status badge text', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    expect(screen.getByText('approved')).toBeInTheDocument();
  });

  it('applies turquoise badge for approved status', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    const badge = screen.getByText('approved').parentElement!;
    expect(badge.className).toContain('bg-turquoise/20');
    expect(badge.className).toContain('text-primary');
  });

  it('applies red badge for rejected status', () => {
    render(<WorkerDocumentsCard {...defaultHandlers} documents={{ ...fullDoc, documentsStatus: 'rejected' }} />);
    const badge = screen.getByText('rejected').parentElement!;
    expect(badge.className).toContain('bg-cancelled/20');
    expect(badge.className).toContain('text-red-700');
  });

  it('applies yellow badge for under_review status', () => {
    render(<WorkerDocumentsCard {...defaultHandlers} documents={{ ...fullDoc, documentsStatus: 'under_review' }} />);
    const badge = screen.getByText('under_review').parentElement!;
    expect(badge.className).toContain('bg-wait/20');
    expect(badge.className).toContain('text-yellow-700');
  });

  it('applies blue badge for submitted status', () => {
    render(<WorkerDocumentsCard {...defaultHandlers} documents={{ ...fullDoc, documentsStatus: 'submitted' }} />);
    const badge = screen.getByText('submitted').parentElement!;
    expect(badge.className).toContain('bg-blue-100');
    expect(badge.className).toContain('text-blue-700');
  });

  it('applies gray badge for pending status', () => {
    render(<WorkerDocumentsCard {...defaultHandlers} documents={{ ...fullDoc, documentsStatus: 'pending' }} />);
    const badge = screen.getByText('pending').parentElement!;
    expect(badge.className).toContain('bg-gray-300');
    expect(badge.className).toContain('text-gray-800');
  });

  it('applies gray badge for incomplete status', () => {
    render(<WorkerDocumentsCard {...defaultHandlers} documents={{ ...fullDoc, documentsStatus: 'incomplete' }} />);
    const badge = screen.getByText('incomplete').parentElement!;
    expect(badge.className).toContain('bg-gray-300');
    expect(badge.className).toContain('text-gray-800');
  });

  it('applies gray fallback for unknown status', () => {
    render(<WorkerDocumentsCard {...defaultHandlers} documents={{ ...fullDoc, documentsStatus: 'some_unknown' }} />);
    const badge = screen.getByText('some_unknown').parentElement!;
    expect(badge.className).toContain('bg-gray-300');
  });

  // ── Review notes ───────────────────────────────────────────────────────────

  it('renders review notes text when present', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    expect(screen.getByText('Tudo verificado.')).toBeInTheDocument();
  });

  it('hides review notes section when reviewNotes is null', () => {
    render(<WorkerDocumentsCard {...defaultHandlers} documents={{ ...fullDoc, reviewNotes: null }} />);
    expect(screen.queryByText('admin.workerDetail.reviewNotes')).not.toBeInTheDocument();
  });

  // ── Document card links ───────────────────────────────────────────────────

  it('renders view buttons for documents with URLs', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    // resume_cv + identity_document + criminal_record = 3 documents with URLs
    const viewButtons = screen.getAllByLabelText('Visualizar documento');
    expect(viewButtons.length).toBe(3);
  });

  // ── DNI pair logic ────────────────────────────────────────────────────────

  it('shows uploaded state for identity back when URL is present', () => {
    const docWithBack = { ...fullDoc, identityDocumentBackUrl: 'https://storage.example.com/id-back.pdf' };
    render(<WorkerDocumentsCard documents={docWithBack} {...defaultHandlers} />);
    const uploadedCards = screen.getAllByRole('generic').filter(
      (el) => el.getAttribute('data-state') === 'uploaded',
    );
    // resume + identity + criminal + identityBack = 4 uploaded
    expect(uploadedCards.length).toBe(4);
  });

  // ── Validation badges ────────────────────────────────────────────────────

  it('renders validate button for uploaded document without validation', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    // resume_cv is uploaded and not validated → shows "Validar" button
    const validateBtn = screen.getByTestId('validate-btn-resume_cv');
    expect(validateBtn).toBeInTheDocument();
    expect(validateBtn.textContent).toContain('admin.workerDetail.validateDoc');
  });

  it('does not render any validation UI when documents is null', () => {
    render(<WorkerDocumentsCard documents={null} {...defaultHandlers} />);
    expect(screen.queryByTestId(/validate-btn-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/validation-badge-/)).not.toBeInTheDocument();
  });

  it('renders validated badge when documentValidations provided for uploaded doc', () => {
    const validations: DocumentValidations = {
      resume_cv: { validatedBy: 'admin@enlite.com', validatedAt: '2026-04-12T10:00:00Z' },
    };
    render(
      <WorkerDocumentsCard
        documents={fullDoc}
        {...defaultHandlers}
        documentValidations={validations}
      />,
    );
    const badge = screen.getByTestId('validation-badge-resume_cv');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('admin.workerDetail.validatedBy');
    expect(badge.textContent).toContain('admin@enlite.com');
  });

  it('calls onValidate when validate button is clicked and confirmed in modal', () => {
    const onValidate = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkerDocumentsCard
        documents={fullDoc}
        {...defaultHandlers}
        onValidate={onValidate}
      />,
    );
    fireEvent.click(screen.getByTestId('validate-btn-resume_cv'));
    fireEvent.click(screen.getByTestId('confirm-validation-btn'));
    expect(onValidate).toHaveBeenCalledWith('resume_cv');
  });

  it('calls onInvalidate when remove validation button is clicked', () => {
    const onInvalidate = vi.fn().mockResolvedValue(undefined);
    const validations: DocumentValidations = {
      resume_cv: { validatedBy: 'admin@enlite.com', validatedAt: '2026-04-12T10:00:00Z' },
    };
    render(
      <WorkerDocumentsCard
        documents={fullDoc}
        {...defaultHandlers}
        onInvalidate={onInvalidate}
        documentValidations={validations}
      />,
    );
    fireEvent.click(screen.getByLabelText('admin.workerDetail.removeValidation'));
    expect(onInvalidate).toHaveBeenCalledWith('resume_cv');
  });

  it('disables validate button when docType is loading', () => {
    const loadingTypes = new Set<AdminDocumentType>(['resume_cv']);
    render(
      <WorkerDocumentsCard
        documents={fullDoc}
        {...defaultHandlers}
        loadingTypes={loadingTypes}
      />,
    );
    const btn = screen.getByTestId('validate-btn-resume_cv');
    expect(btn).toBeDisabled();
  });

  // ── Interações de upload/excluir/ver (repassadas ao DocumentUploadCard) ────

  it('mostra a mensagem de erro do slot quando errors[docType] está preenchido', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} errors={{ resume_cv: 'falhou o upload' }} />);
    expect(screen.getByText('falhou o upload')).toBeInTheDocument();
  });

  it('seleciona um arquivo num slot vazio: chama onUpload com o docType e o arquivo', () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} onUpload={onUpload} />);
    const slot = document.querySelector('[data-testid="doc-slot-identity_document_back"]')!;
    const input = slot.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'dni-back.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onUpload).toHaveBeenCalledWith('identity_document_back', file);
  });

  it('clica no ícone de excluir de um doc enviado: chama onDelete com o docType', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} onDelete={onDelete} />);
    const slot = document.querySelector('[data-testid="doc-slot-resume_cv"]')!;
    fireEvent.click(slot.querySelector('button[aria-label="Remover documento"]')!);
    expect(onDelete).toHaveBeenCalledWith('resume_cv');
  });

  it('clica no ícone de visualizar: chama onView com a URL do documento', () => {
    const onView = vi.fn().mockResolvedValue(undefined);
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} onView={onView} />);
    const slot = document.querySelector('[data-testid="doc-slot-resume_cv"]')!;
    fireEvent.click(slot.querySelector('button[aria-label="Visualizar documento"]')!);
    expect(onView).toHaveBeenCalledWith(fullDoc.resumeCvUrl);
  });

  // ── D269 — worker_document:write/delete gateiam upload e exclusão ─────────

  it('D269 — enforcement=on sem worker_document:write: slot vazio não tem input de arquivo', () => {
    comEnforcement([], 'on');
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    const slot = document.querySelector('[data-testid="doc-slot-identity_document_back"]')!;
    expect(slot.querySelector('input[type="file"]')).toBeNull();
  });

  it('D269 — enforcement=on sem worker_document:delete: ícone de excluir SOME (visualizar continua)', () => {
    comEnforcement([], 'on');
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    const slot = document.querySelector('[data-testid="doc-slot-resume_cv"]')!;
    expect(slot.querySelector('button[aria-label="Remover documento"]')).toBeNull();
    expect(slot.querySelector('button[aria-label="Visualizar documento"]')).not.toBeNull();
  });

  it('D269 — enforcement=on com worker_document:write e :delete: input e ícone de excluir existem', () => {
    comEnforcement(['worker_document:create', 'worker_document:delete'], 'on');
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    const emptySlot = document.querySelector('[data-testid="doc-slot-identity_document_back"]')!;
    expect(emptySlot.querySelector('input[type="file"]')).not.toBeNull();
    const uploadedSlot = document.querySelector('[data-testid="doc-slot-resume_cv"]')!;
    expect(uploadedSlot.querySelector('button[aria-label="Remover documento"]')).not.toBeNull();
  });
});
