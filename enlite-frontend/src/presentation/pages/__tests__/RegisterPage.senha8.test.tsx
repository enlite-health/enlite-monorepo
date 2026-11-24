import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { RegisterPage } from '../RegisterPage';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ state: null, pathname: '/register', search: '', hash: '' }),
  Link: ({ children, to, ...rest }: any) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'es' } }),
}));
const mockInitWorker = vi.fn();
vi.mock('@presentation/hooks/useRegisterUser', () => ({
  useRegisterUser: () => ({ register: vi.fn().mockResolvedValue({ id: 'u1' }), isLoading: false }),
}));
vi.mock('@presentation/hooks/useWorkerEmailLookup', () => ({
  useWorkerEmailLookup: () => ({ lookup: vi.fn(), reset: vi.fn(), isLoading: false, found: null, phoneMasked: undefined }),
}));
vi.mock('@infrastructure/http/WorkerApiService', () => ({
  WorkerApiService: {
    initWorker: (...a: any[]) => mockInitWorker(...a),
    lookupByEmail: () => Promise.resolve({ found: false }),
  },
}));
vi.mock('@presentation/components/features/auth/GoogleLoginButton', () => ({ GoogleLoginButton: () => null }));
vi.mock('@presentation/components/features/auth/ClaimOtpModal', () => ({ ClaimOtpModal: () => null }));
vi.mock('@presentation/components/shared/PhoneInputIntl', () => ({
  PhoneInputIntl: ({ value, onChange }: any) => (
    <input data-testid="phone-input" value={value} onChange={(e: any) => onChange(e.target.value)} />
  ),
}));
vi.mock('@presentation/components/atoms', () => ({
  Typography: ({ children }: any) => <span>{children}</span>,
  Checkbox: ({ id, checked, onChange }: any) => (
    <input id={id} type="checkbox" checked={checked} onChange={onChange} data-testid={`checkbox-input-${id}`} />
  ),
  Divider: () => <hr />,
}));
vi.mock('@presentation/components/atoms/Button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock('@presentation/components/molecules', () => ({
  FormField: ({ children, label }: any) => <div><label>{label}</label>{children}</div>,
  InputWithIcon: ({ id, value, onChange, ...rest }: any) => (
    <input id={id} value={value} onChange={onChange} data-testid={`input-${id}`} {...rest} />
  ),
  PasswordInput: ({ id, value, onChange }: any) => (
    <input id={id} type="password" value={value} onChange={onChange} data-testid={`input-${id}`} />
  ),
}));
vi.mock('@presentation/components/organisms/AuthNavbar', () => ({ AuthNavbar: ({ actions }: any) => <nav>{actions}</nav> }));
vi.mock('@presentation/utils/authErrorMapper', () => ({ getAuthErrorMessage: (e: Error) => e.message }));

function enviar(password: string) {
  render(<RegisterPage />);
  fireEvent.change(screen.getByTestId('input-email'), { target: { value: 'test@example.com' } });
  fireEvent.change(screen.getByTestId('input-password'), { target: { value: password } });
  fireEvent.change(screen.getByTestId('input-confirmPassword'), { target: { value: password } });
  fireEvent.click(screen.getByTestId('checkbox-input-lgpdOptIn'));
  fireEvent.submit(screen.getByTestId('input-email').closest('form')!);
}

const banner = () => document.querySelector('.bg-red-50')?.textContent;

describe('RegisterPage senha 8 + 4 classes (D770)', () => {
  it('T-F3c-39: 7 caracteres (Abcde1!) recusa por tamanho', async () => {
    enviar('Abcde1!');
    await waitFor(() => expect(banner()).toBe('auth.action.passwordMin'));
  });
  it('T-F3c-39: sem maiúscula (abcdef1!) recusa pelos requisitos', async () => {
    enviar('abcdef1!');
    await waitFor(() => expect(banner()).toBe('auth.errors.passwordRequirements'));
  });
  it('T-F3c-39: sem especial (Abcdefg1) recusa pelos requisitos', async () => {
    enviar('Abcdefg1');
    await waitFor(() => expect(banner()).toBe('auth.errors.passwordRequirements'));
  });
  it('T-F3c-39: completa (Abcdef1!) aceita e segue para o cadastro', async () => {
    mockInitWorker.mockResolvedValue({ id: 'w1' });
    enviar('Abcdef1!');
    await waitFor(() => expect(mockInitWorker).toHaveBeenCalled());
    expect(banner()).toBeUndefined();
  });
});
