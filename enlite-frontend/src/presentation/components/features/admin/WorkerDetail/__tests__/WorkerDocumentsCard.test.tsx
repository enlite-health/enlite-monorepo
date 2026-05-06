import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkerDocumentsCard } from '../WorkerDocumentsCard';
import type { WorkerDocument, DocumentValidations } from '@domain/entities/Worker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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
  loadingTypes: new Set() as Set<any>,
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
  additionalCertificatesUrls: ['https://storage.example.com/cert1.pdf'],
  documentsStatus: 'approved',
  reviewNotes: 'Tudo verificado.',
  reviewedBy: 'admin-1',
  reviewedAt: '2026-03-15T00:00:00Z',
  submittedAt: '2026-03-10T00:00:00Z',
};

describe('WorkerDocumentsCard', () => {
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
    expect(screen.getByText('admin.workerDetail.resume')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.identityDoc')).toBeInTheDocument();
  });

  it('renders document labels for all document types', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    expect(screen.getByText('admin.workerDetail.resume')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.identityDoc')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.criminalRecord')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.professionalReg')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.insurance')).toBeInTheDocument();
  });

  // ── Document card links ───────────────────────────────────────────────────

  it('renders view buttons for documents with URLs', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    // cv + id + criminal = 3 documents with URLs → 3 view buttons
    // (additionalCertificatesUrls moved to AdditionalDocumentsSection)
    const viewButtons = screen.getAllByLabelText('Visualizar documento');
    expect(viewButtons.length).toBe(3);
  });

  it('renders uploaded state for documents with URLs', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    const uploadedCards = screen.getAllByRole('generic').filter(
      el => el.getAttribute('data-state') === 'uploaded',
    );
    // resume, identity, criminal = 3 uploaded
    // (additionalCertificatesUrls moved to AdditionalDocumentsSection)
    expect(uploadedCards.length).toBe(3);
  });

  it('renders empty state for documents without URLs', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    const emptyCards = screen.getAllByRole('button').filter(
      el => el.getAttribute('data-state') === 'empty',
    );
    // professionalReg + insurance + identityDocumentBack = 3 empty (profession is null, so AT docs hidden)
    expect(emptyCards.length).toBe(3);
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

  // Note: additional certificates are now handled by AdditionalDocumentsSection component
  // and stored in worker_additional_documents table, not in the deprecated TEXT[] array

  // ── AT profession — conditional docs ──────────────────────────────────────

  it('shows monotributo and AT certificate slots when profession is AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    expect(screen.getByText('admin.workerDetail.monotributo')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.atCertificate')).toBeInTheDocument();
  });

  it('hides monotributo and AT certificate slots when profession is null', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession={null} />);
    expect(screen.queryByText('admin.workerDetail.monotributo')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.workerDetail.atCertificate')).not.toBeInTheDocument();
  });

  it('hides monotributo and AT certificate slots when profession is not AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="PSICO" />);
    expect(screen.queryByText('admin.workerDetail.monotributo')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.workerDetail.atCertificate')).not.toBeInTheDocument();
  });

  it('shows AT warning banner when profession is AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    expect(screen.getByText('documents.atRequiredWarning')).toBeInTheDocument();
  });

  it('hides AT warning banner when profession is not AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="PSICO" />);
    expect(screen.queryByText('documents.atRequiredWarning')).not.toBeInTheDocument();
  });

  // ── New document slots ────────────────────────────────────────────────────

  it('shows identity document back slot label', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    expect(screen.getByText('admin.workerDetail.identityDocBack')).toBeInTheDocument();
  });

  it('renders 8 document cards when profession is AT', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession="AT" />);
    // 6 base slots + 2 AT-only slots = 8 cards
    const allCards = screen.getAllByRole('generic').filter(
      el => el.getAttribute('data-state') === 'uploaded' || el.getAttribute('data-state') === 'empty',
    );
    const allButtons = screen.getAllByRole('button').filter(
      el => el.getAttribute('data-state') === 'empty',
    );
    expect(allCards.length + allButtons.length).toBe(8);
  });

  it('renders 6 document cards when profession is null', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} profession={null} />);
    // 6 base slots only (AT-only slots hidden)
    const uploadedCards = screen.getAllByRole('generic').filter(
      el => el.getAttribute('data-state') === 'uploaded',
    );
    const emptyButtons = screen.getAllByRole('button').filter(
      el => el.getAttribute('data-state') === 'empty',
    );
    expect(uploadedCards.length + emptyButtons.length).toBe(6);
  });

  // ── DNI pair logic ────────────────────────────────────────────────────────

  it('shows uploaded state for identity back when URL is present', () => {
    const docWithBack = { ...fullDoc, identityDocumentBackUrl: 'https://storage.example.com/id-back.pdf' };
    render(<WorkerDocumentsCard documents={docWithBack} {...defaultHandlers} />);
    const uploadedCards = screen.getAllByRole('generic').filter(
      el => el.getAttribute('data-state') === 'uploaded',
    );
    // resume + identity + criminal + identityBack = 4 uploaded
    expect(uploadedCards.length).toBe(4);
  });

  it('shows empty state for identity back when URL is null', () => {
    // fullDoc already has identityDocumentBackUrl: null
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    const emptyButtons = screen.getAllByRole('button').filter(
      el => el.getAttribute('data-state') === 'empty',
    );
    // professionalReg + insurance + identityDocumentBack = 3 empty (profession is null)
    expect(emptyButtons.length).toBe(3);
  });

  // ── Validation badges ────────────────────────────────────────────────────

  it('renders validate button for uploaded document without validation', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    // resume_cv is uploaded and not validated → shows "Validar" button
    const validateBtn = screen.getByTestId('validate-btn-resume_cv');
    expect(validateBtn).toBeInTheDocument();
    expect(validateBtn.textContent).toContain('admin.workerDetail.validateDoc');
  });

  it('does not render validate button for documents without URL', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...defaultHandlers} />);
    // professional_registration has no URL → no badge
    expect(screen.queryByTestId('validate-btn-professional_registration')).not.toBeInTheDocument();
    expect(screen.queryByTestId('validation-badge-professional_registration')).not.toBeInTheDocument();
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
    const loadingTypes = new Set(['resume_cv']) as Set<any>;
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
});
