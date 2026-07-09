import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RoleSelect } from '../RoleSelect';

// i18n mock — returns the key so we can assert exact paths / no raw enum leak.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('RoleSelect (modal de papel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renderiza as duas opções de papel (Titular / Substituto)', () => {
    render(<RoleSelect onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('role-modal')).toBeInTheDocument();
    expect(screen.getByTestId('role-option-titular')).toBeInTheDocument();
    expect(screen.getByTestId('role-option-rapid-response')).toBeInTheDocument();
    // Enum sempre via i18n (renderiza a chave, nunca o valor cru TITULAR).
    expect(screen.getByText('admin.kanban.roleModal.options.TITULAR')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.roleModal.options.RAPID_RESPONSE')).toBeInTheDocument();
  });

  it('confirmar fica desabilitado até escolher um papel', () => {
    render(<RoleSelect onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('role-confirm')).toBeDisabled();
  });

  it('escolher TITULAR e confirmar chama onSubmit com "TITULAR"', () => {
    const onSubmit = vi.fn();
    render(<RoleSelect onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(within(screen.getByTestId('role-option-titular')).getByRole('radio'));
    expect(screen.getByTestId('role-confirm')).toBeEnabled();
    fireEvent.click(screen.getByTestId('role-confirm'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('TITULAR');
  });

  it('escolher Substituto chama onSubmit com "RAPID_RESPONSE"', () => {
    const onSubmit = vi.fn();
    render(<RoleSelect onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(within(screen.getByTestId('role-option-rapid-response')).getByRole('radio'));
    fireEvent.click(screen.getByTestId('role-confirm'));

    expect(onSubmit).toHaveBeenCalledWith('RAPID_RESPONSE');
  });

  it('cancelar chama onCancel e não onSubmit', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<RoleSelect onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId('role-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
