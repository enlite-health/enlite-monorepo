import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VacancyDescriptionEditModal } from '../VacancyDescriptionEditModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockUpdate = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updateTalentumDescription: (...args: unknown[]) => mockUpdate(...args),
  },
}));

const VAC = 'vac-1';

function renderModal(props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  render(
    <VacancyDescriptionEditModal
      isOpen
      vacancyId={VAC}
      currentDescription={'Descripción actual'}
      onClose={onClose}
      onSuccess={onSuccess}
      {...props}
    />,
  );
  return { onClose, onSuccess };
}

beforeEach(() => vi.clearAllMocks());

describe('VacancyDescriptionEditModal', () => {
  it('pré-preenche o textarea com a descrição atual', () => {
    renderModal();
    const ta = screen.getByTestId('vacancy-description-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('Descripción actual');
  });

  it('salva a descrição editada e chama onSuccess', async () => {
    mockUpdate.mockResolvedValueOnce({ description: 'Editada', propagated: true });
    const { onSuccess } = renderModal();

    const ta = screen.getByTestId('vacancy-description-textarea');
    fireEvent.change(ta, { target: { value: 'Editada' } });
    fireEvent.click(screen.getByTestId('vacancy-description-save'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(VAC, 'Editada'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('desabilita salvar quando a descrição fica vazia', () => {
    renderModal();
    const ta = screen.getByTestId('vacancy-description-textarea');
    fireEvent.change(ta, { target: { value: '   ' } });
    expect(screen.getByTestId('vacancy-description-save')).toBeDisabled();
  });

  it('mostra erro da API (ex: 409 vaga de outra conta) e não chama onSuccess', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Esta vacante fue creada directamente en Talentum por otra cuenta'));
    const { onSuccess } = renderModal();

    fireEvent.change(screen.getByTestId('vacancy-description-textarea'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('vacancy-description-save'));

    await waitFor(() => expect(screen.getByText(/otra cuenta/i)).toBeInTheDocument());
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
