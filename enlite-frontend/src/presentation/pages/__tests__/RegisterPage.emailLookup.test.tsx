/**
 * RegisterPage.emailLookup.test.tsx
 *
 * Testes unitários focados no comportamento da RegisterPage quando o email lookup
 * retorna um worker existente (found=true, phoneMasked presente).
 *
 * Gap 1: auth/email-already-in-use + workerFound=true → redirect para /login
 * Gap 2: phone mascarado NÃO é enviado no payload de initWorker (whatsappPhone: undefined)
 * Gap 3: Fluxo integrado frontend com mock — comentado quanto à limitação de backend real
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { FirebaseError } from 'firebase/app';
import { RegisterPage } from '../RegisterPage';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
const mockRegister = vi.fn();
const mockInitWorker = vi.fn();

let mockWorkerEmailLookupState: {
  found: boolean | null;
  phoneMasked?: string;
  isLoading: boolean;
} = { found: null, isLoading: false };

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: null, pathname: '/register', search: '', hash: '' }),
  Link: ({ children, to, ...rest }: any) => <a href={to} {...rest}>{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'es' },
  }),
}));

vi.mock('@presentation/hooks/useRegisterUser', () => ({
  useRegisterUser: () => ({
    register: mockRegister,
    isLoading: false,
  }),
}));

vi.mock('@presentation/hooks/useWorkerEmailLookup', () => ({
  useWorkerEmailLookup: () => ({
    lookup: vi.fn(),
    reset: vi.fn(),
    isLoading: mockWorkerEmailLookupState.isLoading,
    found: mockWorkerEmailLookupState.found,
    phoneMasked: mockWorkerEmailLookupState.phoneMasked,
  }),
}));

vi.mock('@infrastructure/http/WorkerApiService', () => ({
  WorkerApiService: {
    initWorker: (...args: any[]) => mockInitWorker(...args),
  },
}));

vi.mock('@presentation/components/features/auth/GoogleLoginButton', () => ({
  GoogleLoginButton: ({ onSuccess }: any) => (
    <button data-testid="google-btn" onClick={onSuccess}>Google</button>
  ),
}));

vi.mock('@presentation/components/features/auth/ClaimOtpModal', () => ({
  ClaimOtpModal: ({ open }: any) =>
    open ? <div data-testid="claim-otp-modal" /> : null,
}));

vi.mock('@presentation/components/shared/PhoneInputIntl', () => ({
  PhoneInputIntl: ({ value, onChange }: any) => (
    <input data-testid="phone-input" value={value} onChange={(e: any) => onChange(e.target.value)} />
  ),
}));

vi.mock('@presentation/components/atoms', () => ({
  Typography: ({ children }: any) => <span>{children}</span>,
  Checkbox: ({ id, labelContent, checked, onChange, error }: any) => (
    <div data-testid={`checkbox-${id}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        data-testid={`checkbox-input-${id}`}
      />
      {labelContent
        ? <div data-testid={`checkbox-labelcontent-${id}`}>{labelContent}</div>
        : null
      }
      {error && <span data-testid={`checkbox-error-${id}`}>{error}</span>}
    </div>
  ),
  Divider: () => <hr />,
}));

vi.mock('@presentation/components/atoms/Button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@presentation/components/molecules', () => ({
  FormField: ({ children, label }: any) => <div><label>{label}</label>{children}</div>,
  InputWithIcon: ({ id, value, onChange, disabled, readOnly, ...rest }: any) => (
    <input
      id={id}
      value={value ?? ''}
      onChange={onChange}
      disabled={disabled}
      readOnly={readOnly}
      data-testid={`input-${id}`}
      {...rest}
    />
  ),
  PasswordInput: ({ id, value, onChange }: any) => (
    <input id={id} type="password" value={value} onChange={onChange} data-testid={`input-${id}`} />
  ),
}));

vi.mock('@presentation/components/organisms/AuthNavbar', () => ({
  AuthNavbar: ({ actions }: any) => <nav>{actions}</nav>,
}));

vi.mock('@presentation/utils/authErrorMapper', () => ({
  getAuthErrorMessage: (err: Error) => err.message,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fillFormWithWorkerFound(overrides: {
  email?: string;
  password?: string;
  confirmPassword?: string;
} = {}) {
  const email = overrides.email ?? 'worker@example.com';
  const password = overrides.password ?? 'password123';
  const confirmPassword = overrides.confirmPassword ?? 'password123';

  fireEvent.change(screen.getByTestId('input-email'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('input-password'), { target: { value: password } });
  fireEvent.change(screen.getByTestId('input-confirmPassword'), { target: { value: confirmPassword } });
  fireEvent.click(screen.getByTestId('checkbox-input-lgpdOptIn'));
}

function submitForm() {
  const form = screen.getByTestId('input-email').closest('form')!;
  fireEvent.submit(form);
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('RegisterPage — Email Lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockWorkerEmailLookupState = { found: null, isLoading: false };
    mockRegister.mockResolvedValue({ id: 'uid-123', email: 'worker@example.com' });
    // Onda 2: initWorker returns discriminated union { status: 'ok', worker }
    mockInitWorker.mockResolvedValue({ status: 'ok', worker: {} });
  });

  // ── Gap 1: auth/email-already-in-use + workerFound=true → redirect /login ──

  describe('Gap 1: auth/email-already-in-use + workerFound=true → redireciona para /login', () => {
    it('redireciona para /login quando register lança auth/email-already-in-use e worker foi encontrado', async () => {
      // Arrange: worker já existe na base (lookup encontrou)
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };
      mockRegister.mockRejectedValue(
        new FirebaseError('auth/email-already-in-use', 'Email already in use'),
      );

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'worker@example.com' });
      submitForm();

      // Assert: deve navegar para /login com email no state
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(
          '/login',
          expect.objectContaining({ state: expect.objectContaining({ email: 'worker@example.com' }) }),
        );
      });
    });

    it('NÃO mostra banner de erro quando o redirect acontece (auth/email-already-in-use + workerFound=true)', async () => {
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };
      mockRegister.mockRejectedValue(
        new FirebaseError('auth/email-already-in-use', 'Email already in use'),
      );

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'worker@example.com' });
      submitForm();

      // O redirect acontece antes de qualquer setError
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/login', expect.anything());
      });

      // O banner de erro não deve estar visível
      const banner = document.querySelector('.bg-red-50');
      expect(banner).toBeNull();
    });

    it('NÃO redireciona para /login quando auth/email-already-in-use mas worker NÃO foi encontrado', async () => {
      // worker NOT found — error deve ser exibido no banner, não redirect
      mockWorkerEmailLookupState = { found: false, isLoading: false };
      mockRegister.mockRejectedValue(
        new FirebaseError('auth/email-already-in-use', 'Email already in use'),
      );

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'newworker@example.com' });
      submitForm();

      await waitFor(() => {
        const banner = document.querySelector('.bg-red-50');
        expect(banner).toBeTruthy();
      });

      expect(mockNavigate).not.toHaveBeenCalledWith('/login', expect.anything());
    });

    it('NÃO redireciona para /login quando lookup ainda não foi feito (found=null) e ocorre auth/email-already-in-use', async () => {
      mockWorkerEmailLookupState = { found: null, isLoading: false };
      mockRegister.mockRejectedValue(
        new FirebaseError('auth/email-already-in-use', 'Email already in use'),
      );

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'unknown@example.com' });
      submitForm();

      await waitFor(() => {
        const banner = document.querySelector('.bg-red-50');
        expect(banner).toBeTruthy();
      });

      expect(mockNavigate).not.toHaveBeenCalledWith('/login', expect.anything());
    });

    it('inclui o email no state de navegação ao redirecionar para /login', async () => {
      const testEmail = 'specific-worker@example.com';
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };
      mockRegister.mockRejectedValue(
        new FirebaseError('auth/email-already-in-use', 'Email already in use'),
      );

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: testEmail });
      submitForm();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(
          '/login',
          expect.objectContaining({
            state: expect.objectContaining({ email: testEmail }),
          }),
        );
      });
    });
  });

  // ── Gap 2: phone mascarado NÃO é enviado no payload de initWorker ──────────

  describe('Gap 2: phone mascarado NÃO é enviado no payload quando campo está desabilitado', () => {
    it('initWorker é chamado com whatsappPhone: undefined e phone: undefined quando phone está mascarado/desabilitado', async () => {
      // Arrange: worker existente com phone mascarado
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };
      mockRegister.mockResolvedValue({ id: 'uid-123', email: 'worker@example.com' });

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'worker@example.com' });

      // O campo de phone está desabilitado (InputWithIcon com disabled=true) — não alteramos seu valor
      // O whatsapp state permanece '' (string vazia)

      submitForm();

      await waitFor(() => {
        expect(mockInitWorker).toHaveBeenCalled();
      });

      const callArgs = mockInitWorker.mock.calls[0][0];

      // O valor mascarado 'xxxxxxxxxx978' NUNCA deve ser enviado
      expect(callArgs.whatsappPhone).not.toBe('xxxxxxxxxx978');
      // Com string vazia, whatsapp || undefined resulta em undefined
      expect(callArgs.whatsappPhone).toBeUndefined();
      // phone também deve ser undefined (mesmo campo de origem)
      expect(callArgs.phone).toBeUndefined();
    });

    it('initWorker NÃO recebe o valor mascarado como whatsappPhone em nenhuma circunstância', async () => {
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };
      mockRegister.mockResolvedValue({ id: 'uid-456', email: 'worker2@example.com' });

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'worker2@example.com' });
      submitForm();

      await waitFor(() => {
        expect(mockInitWorker).toHaveBeenCalled();
      });

      const allCalls = mockInitWorker.mock.calls;
      // Em nenhuma chamada o valor mascarado deve aparecer
      for (const [payload] of allCalls) {
        expect(payload.whatsappPhone).not.toBe('xxxxxxxxxx978');
        // Se o valor for string, garantir que não contém o padrão mascarado
        if (typeof payload.whatsappPhone === 'string') {
          expect(payload.whatsappPhone).not.toContain('xxxxxxxxxx');
        }
      }
    });

    it('initWorker recebe o phone quando worker NÃO é encontrado e usuário preenche o campo', async () => {
      // Worker não encontrado — campo habilitado — usuário digita phone
      mockWorkerEmailLookupState = { found: false, isLoading: false };
      mockRegister.mockResolvedValue({ id: 'uid-789', email: 'newworker@example.com' });

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'newworker@example.com' });

      // Simula preenchimento do PhoneInputIntl (mockado como data-testid="phone-input")
      fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112345678' } });

      submitForm();

      await waitFor(() => {
        expect(mockInitWorker).toHaveBeenCalled();
      });

      const callArgs = mockInitWorker.mock.calls[0][0];
      expect(callArgs.whatsappPhone).toBe('+5491112345678');
      // phone deve ter o mesmo valor que whatsappPhone (duplo envio para reconciliação no backend)
      expect(callArgs.phone).toBe('+5491112345678');
    });

    it('campo de phone fica desabilitado e exibe valor mascarado quando workerFound=true com phoneMasked', () => {
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };

      render(<RegisterPage />);

      // Com phoneDisabled=true, renderiza input#whatsapp (InputWithIcon) em vez do PhoneInputIntl
      const maskedInput = screen.getByTestId('input-whatsapp');
      expect(maskedInput).toBeDefined();
      expect(maskedInput).toBeDisabled();
      expect(maskedInput).toHaveAttribute('value', 'xxxxxxxxxx978');
    });

    it('campo de phone NÃO está desabilitado quando workerFound=false', () => {
      mockWorkerEmailLookupState = { found: false, isLoading: false };

      render(<RegisterPage />);

      // Com phoneDisabled=false, renderiza PhoneInputIntl
      const phoneInput = screen.getByTestId('phone-input');
      expect(phoneInput).toBeDefined();
      expect(phoneInput).not.toBeDisabled();
    });
  });

  // ── Gap 3: Fluxo integrado (documentado com limitação de backend real) ──────

  describe('Gap 3: Fluxo integrado com mock de lookup (backend real não disponível em testes unitários)', () => {
    /**
     * LIMITAÇÃO: Testes unitários (vitest + jsdom) não têm acesso ao backend real.
     * Para testar o fluxo com backend real, use o teste E2E Playwright no arquivo:
     *   e2e/register-email-lookup.visual.e2e.ts
     *
     * O cenário E2E com backend real requere:
     *   - Worker pré-inserido no banco via API ou seed
     *   - Docker containers rodando (frontend + backend)
     *   - O teste E2E usa page.route() APENAS para Firebase (não para lookup)
     *
     * Aqui cobrimos o fluxo completo com mock do lookup para garantir que
     * os estados intermediários estão corretos.
     */

    it('fluxo completo: lookup found=true → phone mascarado exibido → submit → initWorker sem phone mascarado', async () => {
      // Step 1: Simula worker encontrado com phone mascarado
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };
      mockRegister.mockResolvedValue({ id: 'uid-complete', email: 'existing@example.com' });

      render(<RegisterPage />);

      // Step 2: Campo de phone está mascarado e desabilitado
      const maskedInput = screen.getByTestId('input-whatsapp');
      expect(maskedInput).toBeDisabled();
      expect(maskedInput).toHaveAttribute('value', 'xxxxxxxxxx978');

      // Step 3: Usuário preenche os demais campos e submete
      fillFormWithWorkerFound({ email: 'existing@example.com' });
      submitForm();

      // Step 4: Register é chamado normalmente
      await waitFor(() => {
        expect(mockRegister).toHaveBeenCalledWith(
          expect.objectContaining({ lgpdOptIn: true }),
        );
      });

      // Step 5: initWorker é chamado SEM o phone mascarado (phone e whatsappPhone undefined)
      await waitFor(() => {
        expect(mockInitWorker).toHaveBeenCalledWith(
          expect.objectContaining({
            email: 'existing@example.com',
            phone: undefined,
            whatsappPhone: undefined,
          }),
        );
      });

      // Step 6: Navega para home após sucesso
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/');
      });
    });

    it('fluxo completo: lookup found=true → auth/email-already-in-use → redirect /login com email', async () => {
      mockWorkerEmailLookupState = { found: true, phoneMasked: 'xxxxxxxxxx978', isLoading: false };
      mockRegister.mockRejectedValue(
        new FirebaseError('auth/email-already-in-use', 'Email already in use'),
      );

      render(<RegisterPage />);
      fillFormWithWorkerFound({ email: 'existing@example.com' });
      submitForm();

      // O fluxo deve terminar com redirect para login, sem banner de erro
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(
          '/login',
          expect.objectContaining({
            state: expect.objectContaining({ email: 'existing@example.com' }),
          }),
        );
      });

      expect(document.querySelector('.bg-red-50')).toBeNull();
      expect(mockInitWorker).not.toHaveBeenCalled();
    });
  });
});
