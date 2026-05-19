import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // Return interpolated strings so we can assert on them
      if (opts && typeof opts.count === 'number') {
        return `${key}:count=${opts.count}`;
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
}));

import { ResumeDraftVacancyDialog } from '../ResumeDraftVacancyDialog';
import type { VacancyDraftSummary } from '@domain/entities/VacancyDraft';

const draft1: VacancyDraftSummary = {
  id: 'draft-aaa',
  case_number: 100,
  vacancy_number: 1,
  title: 'CASO 100-1',
  created_at: new Date(Date.now() - 86400_000).toISOString(),
  updated_at: new Date(Date.now() - 86400_000).toISOString(),
};

const draft2: VacancyDraftSummary = {
  id: 'draft-bbb',
  case_number: 100,
  vacancy_number: 2,
  title: 'CASO 100-2',
  created_at: new Date(Date.now() - 172800_000).toISOString(),
  updated_at: new Date(Date.now() - 172800_000).toISOString(),
};

const defaultProps = {
  isOpen: true,
  drafts: [draft1],
  onResume: vi.fn(),
  onCreateNew: vi.fn(),
  onCancel: vi.fn(),
};

function renderDialog(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return render(<ResumeDraftVacancyDialog {...props} />);
}

describe('ResumeDraftVacancyDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = renderDialog({ isOpen: false });
    expect(container.firstChild).toBeNull();
  });

  it('shows singular title when there is 1 draft', () => {
    renderDialog({ drafts: [draft1] });
    expect(
      screen.getByText('admin.createVacancyV2.resumeDraftDialog.titleSingular'),
    ).toBeInTheDocument();
  });

  it('shows plural title when there are 2+ drafts', () => {
    renderDialog({ drafts: [draft1, draft2] });
    expect(
      screen.getByText('admin.createVacancyV2.resumeDraftDialog.titlePlural'),
    ).toBeInTheDocument();
  });

  it('renders draft items with correct testids', () => {
    renderDialog({ drafts: [draft1, draft2] });
    expect(screen.getByTestId('resume-draft-item-draft-aaa')).toBeInTheDocument();
    expect(screen.getByTestId('resume-draft-item-draft-bbb')).toBeInTheDocument();
  });

  it('calls onResume with the correct id when Retomar is clicked', async () => {
    const onResume = vi.fn();
    renderDialog({ drafts: [draft1], onResume });
    await userEvent.click(screen.getByTestId('resume-draft-btn-draft-aaa'));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledWith('draft-aaa');
  });

  it('calls onResume with the correct id for the right item when multiple drafts exist', async () => {
    const onResume = vi.fn();
    renderDialog({ drafts: [draft1, draft2], onResume });
    await userEvent.click(screen.getByTestId('resume-draft-btn-draft-bbb'));
    expect(onResume).toHaveBeenCalledWith('draft-bbb');
  });

  it('calls onCreateNew when "Crear nueva vacante" is clicked', async () => {
    const onCreateNew = vi.fn();
    renderDialog({ onCreateNew });
    await userEvent.click(screen.getByTestId('resume-draft-create-new'));
    expect(onCreateNew).toHaveBeenCalledOnce();
  });

  it('calls onCancel when "Cancelar" button is clicked', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    await userEvent.click(screen.getByTestId('resume-draft-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Escape key is pressed', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when backdrop is clicked', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    const backdrop = screen.getByTestId('resume-draft-dialog');
    await userEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does NOT call onCancel when inner card is clicked', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    // Click one of the draft items — stopPropagation should prevent backdrop close
    await userEvent.click(screen.getByTestId('resume-draft-item-draft-aaa'));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
