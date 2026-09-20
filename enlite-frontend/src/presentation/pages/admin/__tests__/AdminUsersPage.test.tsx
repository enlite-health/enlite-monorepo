/**
 * AdminUsersPage.test.tsx
 *
 * Unit tests covering:
 * - Renders user list with Nombre/Email/Último login columns (a coluna "Rol"
 *   deixou de existir: papel não é mais um atributo do admin)
 * - "Nuevo Usuario"/Reset/Eliminar aparecem pela CÉLULA, com o freio de
 *   enforcement (D268/D269)
 * - InvitationFallbackModal appears after successful create (mode=create)
 * - InvitationFallbackModal appears after reset password (mode=reset)
 * - DeleteAdminUserModal appears and calls deleteAdmin on confirm
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminUsersPage } from '../AdminUsersPage';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      if (opts?.email) return `Invitación enviada a ${opts.email}`;
      return key;
    },
  }),
}));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockListAdmins     = vi.fn();
const mockCreateAdmin    = vi.fn();
const mockDeleteAdmin    = vi.fn();
const mockResetPassword  = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listAdmins:      (...args: any[]) => mockListAdmins(...args),
    createAdmin:     (...args: any[]) => mockCreateAdmin(...args),
    deleteAdmin:     (...args: any[]) => mockDeleteAdmin(...args),
    resetPassword:   (...args: any[]) => mockResetPassword(...args),
  },
}));

vi.mock('@presentation/components/ui/skeletons', () => ({
  TableSkeleton: () => <div data-testid="skeleton" />,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_USERS = [
  {
    firebaseUid:   'uid-admin-1',
    email:         'admin@enlite.health',
    displayName:   'Admin User',
    department:    null,
    lastLoginAt:   '2026-04-01T10:00:00Z',
    loginCount:    5,
    createdAt:     '2026-01-01T00:00:00Z',
  },
  {
    firebaseUid:   'uid-recruiter-1',
    email:         'recruiter@enlite.health',
    displayName:   'Recruiter User',
    department:    null,
    lastLoginAt:   null,
    loginCount:    0,
    createdAt:     '2026-02-01T00:00:00Z',
  },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockListAdmins.mockResolvedValue({ admins: MOCK_USERS, total: 2 });
  mockCreateAdmin.mockResolvedValue({
    ...MOCK_USERS[0],
    email:     'new@enlite.health',
    resetLink: 'https://reset.link/test',
  });
  mockDeleteAdmin.mockResolvedValue(undefined);
  mockResetPassword.mockResolvedValue({
    resetLink: 'https://reset.link/reset-test',
    message: 'Email enviado',
  });
});

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

async function renderAndWait() {
  await act(async () => {
    render(<AdminUsersPage />);
  });
  // Wait for async state updates (isLoading → false)
  await waitFor(() => expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument(), {
    timeout: 5000,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AdminUsersPage — column headers', () => {
  it('renders Último login column header, e NÃO a coluna de papel (que saiu com o ABAC)', async () => {
    await renderAndWait();
    // Headers come through Typography which renders text directly in DOM
    expect(document.body.textContent).toContain('admin.users.lastLogin');
    expect(document.body.textContent).not.toContain('admin.users.role');
  });

  it('renders display names in rows', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('Admin User');
    expect(document.body.textContent).toContain('Recruiter User');
  });

  it('admin sem displayName cai no travessão, e sem lastLogin também', async () => {
    mockListAdmins.mockResolvedValueOnce({
      admins: [{ ...MOCK_USERS[0], displayName: null }],
      total: 1,
    });
    await renderAndWait();
    expect(document.body.textContent).toContain('—');
  });

  it('não renderiza nenhum <select> — o papel deixou de ser editável na tela', async () => {
    await renderAndWait();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('AdminUsersPage — create flow', () => {
  it('shows InvitationFallbackModal after successful create', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    // Open create modal
    await user.click(screen.getByRole('button', { name: 'admin.users.create' }));
    expect(document.body.textContent).toContain('admin.users.createUserTitle');

    // Fill required fields — IDs are set in CreateAdminUserModal
    const emailInput       = document.getElementById('cu-email') as HTMLInputElement;
    const displayNameInput = document.getElementById('cu-displayName') as HTMLInputElement;
    await user.type(emailInput,       'new@enlite.health');
    await user.type(displayNameInput, 'New User');

    await user.click(screen.getByRole('button', { name: 'admin.users.createButton' }));

    // O convite não carrega papel — o body é só e-mail + nome.
    await waitFor(() =>
      expect(mockCreateAdmin).toHaveBeenCalledWith({ email: 'new@enlite.health', displayName: 'New User' }),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain('admin.users.invitationFallbackTitle'),
    );
    // Reset link is shown
    expect(document.body.textContent).toContain('https://reset.link/test');

    // Fechar a modal de fallback devolve a tela ao estado normal.
    await user.click(screen.getByRole('button', { name: 'admin.users.done' }));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain('admin.users.invitationFallbackTitle'),
    );
  });

  it('createAdmin não é chamado com o formulário incompleto (só e-mail)', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    await user.click(screen.getByRole('button', { name: 'admin.users.create' }));
    await user.type(document.getElementById('cu-email') as HTMLInputElement, 'new@enlite.health');
    await user.click(screen.getByRole('button', { name: 'admin.users.createButton' }));

    expect(mockCreateAdmin).not.toHaveBeenCalled();
  });

  it('fecha a modal de criação pelo Cancelar, sem chamar createAdmin', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    await user.click(screen.getByRole('button', { name: 'admin.users.create' }));
    await user.click(screen.getByRole('button', { name: 'admin.users.cancel' }));

    expect(document.body.textContent).not.toContain('admin.users.createUserTitle');
    expect(mockCreateAdmin).not.toHaveBeenCalled();
  });
});

describe('AdminUsersPage — reset password flow', () => {
  it('shows InvitationFallbackModal in reset mode after clicking reset button', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    const resetButtons = screen.getAllByText('admin.users.reset');
    await user.click(resetButtons[0]);

    await waitFor(() =>
      expect(mockResetPassword).toHaveBeenCalledWith('uid-admin-1'),
    );

    // Fallback modal should open with the reset link
    await waitFor(() =>
      expect(document.body.textContent).toContain('admin.users.resetLinkSentTitle'),
    );
    expect(document.body.textContent).toContain('https://reset.link/reset-test');
  });
});

describe('AdminUsersPage — delete flow', () => {
  it('shows DeleteAdminUserModal and calls deleteAdmin on confirm', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    const deleteButtons = screen.getAllByText('admin.users.delete');
    await user.click(deleteButtons[0]);

    expect(document.body.textContent).toContain('admin.users.confirmDelete');

    await user.click(screen.getByText('admin.users.deleteConfirm'));

    await waitFor(() =>
      expect(mockDeleteAdmin).toHaveBeenCalledWith('uid-admin-1'),
    );
  });

  it('fecha a modal de exclusão pelo Cancelar, sem chamar deleteAdmin', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    await user.click(screen.getAllByText('admin.users.delete')[0]);
    await user.click(screen.getByText('admin.users.cancel'));

    expect(document.body.textContent).not.toContain('admin.users.confirmDelete');
    expect(mockDeleteAdmin).not.toHaveBeenCalled();
  });
});

// ── D269/D286 — a célula é o ÚNICO freio (POST /users, POST /:id/reset-password,
// DELETE /:id): papel não decide mais nada nesta tela ───────────────────────

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: [],
  groups: [],
  features: {},
  enforcement,
});

describe('AdminUsersPage — célula (enforcement "on")', () => {
  it('SEM nenhuma célula → Crear/Reset/Eliminar somem (fora do DOM, não desabilitados)', async () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
    await renderAndWait();

    expect(screen.queryByRole('button', { name: 'admin.users.create' })).not.toBeInTheDocument();
    expect(screen.queryByText('admin.users.reset')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.users.delete')).not.toBeInTheDocument();
  });

  it('COM user_management:create/update/delete (PR-8b) → Crear, Reset e Eliminar aparecem', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['user_management:create', 'user_management:update', 'user_management:delete'], 'on'),
    });
    await renderAndWait();

    expect(screen.getByRole('button', { name: 'admin.users.create' })).toBeInTheDocument();
    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
  });

  it('SEM user_management:create especificamente (PR-8b) → só o Crear some, Reset e Eliminar ficam', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['user_management:update', 'user_management:delete'], 'on'),
    });
    await renderAndWait();

    expect(screen.queryByRole('button', { name: 'admin.users.create' })).not.toBeInTheDocument();
    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
  });

  it('SEM user_management:update especificamente (PR-8b) → só o Reset some, Crear e Eliminar ficam', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['user_management:create', 'user_management:delete'], 'on'),
    });
    await renderAndWait();

    expect(screen.getByRole('button', { name: 'admin.users.create' })).toBeInTheDocument();
    expect(screen.queryByText('admin.users.reset')).not.toBeInTheDocument();
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
  });

  it('SEM user_management:delete especificamente → só o Eliminar some', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['user_management:create', 'user_management:update'], 'on'),
    });
    await renderAndWait();

    expect(screen.getByRole('button', { name: 'admin.users.create' })).toBeInTheDocument();
    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.queryByText('admin.users.delete')).not.toBeInTheDocument();
  });
});

describe('AdminUsersPage — erro e lista vazia', () => {
  it('mostra o banner de erro quando listAdmins falha, e o botão × o descarta', async () => {
    mockListAdmins.mockRejectedValueOnce(new Error('boom'));
    await renderAndWait();

    expect(document.body.textContent).toContain('boom');

    const user = userEvent.setup();
    await user.click(screen.getByText('×'));

    expect(document.body.textContent).not.toContain('boom');
  });

  it('erro sem `message` (rejeição não-Error) cai no texto genérico', async () => {
    mockListAdmins.mockRejectedValueOnce('boom cru');
    await renderAndWait();

    expect(document.body.textContent).toContain('Error');
  });

  it('mostra o empty state quando não há admins', async () => {
    mockListAdmins.mockResolvedValueOnce({ admins: [], total: 0 });
    await renderAndWait();

    expect(document.body.textContent).toContain('admin.users.empty');
  });

  it('mostra o erro quando deleteAdmin falha', async () => {
    const user = userEvent.setup();
    mockDeleteAdmin.mockRejectedValueOnce(new Error('delete boom'));
    await renderAndWait();

    await user.click(screen.getAllByText('admin.users.delete')[0]);
    await user.click(screen.getByText('admin.users.deleteConfirm'));

    await waitFor(() => expect(document.body.textContent).toContain('delete boom'));
  });

  it('deleteAdmin rejeitando sem Error cai no texto genérico', async () => {
    const user = userEvent.setup();
    mockDeleteAdmin.mockRejectedValueOnce('delete cru');
    await renderAndWait();

    await user.click(screen.getAllByText('admin.users.delete')[0]);
    await user.click(screen.getByText('admin.users.deleteConfirm'));

    await waitFor(() => expect(document.body.textContent).toContain('common.error'));
  });

  it('mostra o erro quando resetPassword falha', async () => {
    const user = userEvent.setup();
    mockResetPassword.mockRejectedValueOnce(new Error('reset boom'));
    await renderAndWait();

    await user.click(screen.getAllByText('admin.users.reset')[0]);

    await waitFor(() => expect(document.body.textContent).toContain('reset boom'));
  });

  it('resetPassword rejeitando sem Error cai na chave de erro da tela', async () => {
    const user = userEvent.setup();
    mockResetPassword.mockRejectedValueOnce('reset cru');
    await renderAndWait();

    await user.click(screen.getAllByText('admin.users.reset')[0]);

    await waitFor(() => expect(document.body.textContent).toContain('admin.users.errorResetPassword'));
  });

  it('mostra o erro quando createAdmin falha', async () => {
    const user = userEvent.setup();
    mockCreateAdmin.mockRejectedValueOnce(new Error('create boom'));
    await renderAndWait();

    await user.click(screen.getByRole('button', { name: 'admin.users.create' }));
    const emailInput = document.getElementById('cu-email') as HTMLInputElement;
    const displayNameInput = document.getElementById('cu-displayName') as HTMLInputElement;
    await user.type(emailInput, 'new@enlite.health');
    await user.type(displayNameInput, 'New User');
    await user.click(screen.getByRole('button', { name: 'admin.users.createButton' }));

    await waitFor(() => expect(document.body.textContent).toContain('create boom'));
  });

  it('createAdmin rejeitando sem Error cai no texto genérico', async () => {
    const user = userEvent.setup();
    mockCreateAdmin.mockRejectedValueOnce('create cru');
    await renderAndWait();

    await user.click(screen.getByRole('button', { name: 'admin.users.create' }));
    await user.type(document.getElementById('cu-email') as HTMLInputElement, 'new@enlite.health');
    await user.type(document.getElementById('cu-displayName') as HTMLInputElement, 'New User');
    await user.click(screen.getByRole('button', { name: 'admin.users.createButton' }));

    await waitFor(() => expect(document.body.textContent).toContain('common.error'));
  });

  it('resposta de criação SEM resetLink → a modal de fallback abre com link vazio', async () => {
    const user = userEvent.setup();
    mockCreateAdmin.mockResolvedValueOnce({ ...MOCK_USERS[0], email: 'new@enlite.health' });
    await renderAndWait();

    await user.click(screen.getByRole('button', { name: 'admin.users.create' }));
    await user.type(document.getElementById('cu-email') as HTMLInputElement, 'new@enlite.health');
    await user.type(document.getElementById('cu-displayName') as HTMLInputElement, 'New User');
    await user.click(screen.getByRole('button', { name: 'admin.users.createButton' }));

    await waitFor(() =>
      expect(document.body.textContent).toContain('admin.users.invitationFallbackTitle'),
    );
  });
});

describe('AdminUsersPage — sem contrato/enforcement "off": tudo aparece, como sempre apareceu', () => {
  it('sem contrato nenhum (authz null) → Crear/Reset/Eliminar visíveis', async () => {
    await renderAndWait();

    expect(screen.getByRole('button', { name: 'admin.users.create' })).toBeInTheDocument();
    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
  });

  it('enforcement "off" SEM célula nenhuma → Crear/Reset/Eliminar continuam visíveis', async () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'off') });
    await renderAndWait();

    expect(screen.getByRole('button', { name: 'admin.users.create' })).toBeInTheDocument();
    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
  });
});
