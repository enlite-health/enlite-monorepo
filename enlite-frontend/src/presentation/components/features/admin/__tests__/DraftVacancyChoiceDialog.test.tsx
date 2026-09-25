import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

import { DraftVacancyChoiceDialog, type DraftVacancyChoiceDialogProps } from '../DraftVacancyChoiceDialog';

const defaultProps: DraftVacancyChoiceDialogProps = {
  isOpen: true,
  vacancyId: 'vac-123',
  onComplete: vi.fn(),
  onViewOnly: vi.fn(),
  onCancel: vi.fn(),
};

function renderDialog(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides };
  return render(<DraftVacancyChoiceDialog {...props} />);
}

// F25/D425/D426 (Fase 3, completar-vacante-em-rascunho) — o modal de escolha que substitui o
// lápis: "Completar vacante" (→ modo edição) e "Solo visualizar" (→ tela do rascunho), mais
// Cancelar. Molde: VacancyModal/__tests__/ResumeDraftVacancyDialog.test.tsx.
describe('DraftVacancyChoiceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = renderDialog({ isOpen: false });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when vacancyId is null (isOpen true but no target)', () => {
    const { container } = renderDialog({ vacancyId: null });
    expect(container.firstChild).toBeNull();
  });

  it('renders the dialog with the title', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.draftChoiceDialog.title')).toBeInTheDocument();
  });

  it('renders exactly 2 actions ("Completar vacante" + "Solo visualizar") plus Cancelar', () => {
    renderDialog();
    expect(screen.getByTestId('choice-complete')).toBeInTheDocument();
    expect(screen.getByTestId('choice-view')).toBeInTheDocument();
    expect(screen.getByTestId('draft-vacancy-choice-cancel')).toBeInTheDocument();
    // "Completar vacante" reusa a chave já existente (F25) — nunca um rótulo novo pro mesmo botão.
    expect(screen.getByTestId('choice-complete')).toHaveTextContent('admin.vacancies.completeVacancy');
    expect(screen.getByTestId('choice-view')).toHaveTextContent('admin.vacancies.draftChoiceDialog.viewOnly');
  });

  it('calls onComplete with the vacancyId when "Completar vacante" is clicked', async () => {
    const onComplete = vi.fn();
    renderDialog({ onComplete });
    await userEvent.click(screen.getByTestId('choice-complete'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith('vac-123');
  });

  it('calls onViewOnly with the vacancyId when "Solo visualizar" is clicked', async () => {
    const onViewOnly = vi.fn();
    renderDialog({ onViewOnly });
    await userEvent.click(screen.getByTestId('choice-view'));
    expect(onViewOnly).toHaveBeenCalledOnce();
    expect(onViewOnly).toHaveBeenCalledWith('vac-123');
  });

  it('calls onCancel when "Cancelar" is clicked', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    await userEvent.click(screen.getByTestId('draft-vacancy-choice-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Escape key is pressed', () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when the backdrop is clicked', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    await userEvent.click(screen.getByTestId('draft-vacancy-choice-dialog'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does NOT call onCancel when the inner card is clicked', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    await userEvent.click(screen.getByTestId('choice-complete').closest('div')!);
    // stopPropagation no card interno — só o clique no botão dispara onComplete, não onCancel.
    expect(onCancel).not.toHaveBeenCalled();
  });
});
