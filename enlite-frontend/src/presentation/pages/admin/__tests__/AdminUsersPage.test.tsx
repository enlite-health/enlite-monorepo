/**
 * AdminUsersPage.test.tsx
 *
 * Unit tests covering:
 * - Renders user list with Rol, Último login columns
 * - Shows role <select> for admin viewer, badge-only for non-admin
 * - "Nuevo Usuario" button visible only for admin
 * - handleRoleChange calls updateAdminRole then reloads
 * - InvitationFallbackModal appears after successful create (mode=create)
 * - InvitationFallbackModal appears after reset password (mode=reset)
 * - DeleteAdminUserModal appears and calls deleteAdmin on confirm
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminUsersPage } from '../AdminUsersPage';
import { EnliteRole } from '@domain/entities/EnliteRole';
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
const mockUpdateAdminRole = vi.fn();
const mockDeleteAdmin    = vi.fn();
const mockResetPassword  = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listAdmins:      (...args: any[]) => mockListAdmins(...args),
    createAdmin:     (...args: any[]) => mockCreateAdmin(...args),
    updateAdminRole: (...args: any[]) => mockUpdateAdminRole(...args),
    deleteAdmin:     (...args: any[]) => mockDeleteAdmin(...args),
    resetPassword:   (...args: any[]) => mockResetPassword(...args),
  },
}));

// Mutable so individual tests can override
let mockRole: EnliteRole = EnliteRole.ADMIN;

vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: { role: mockRole } }),
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
    role:          EnliteRole.ADMIN,
    department:    null,
    lastLoginAt:   '2026-04-01T10:00:00Z',
    loginCount:    5,
    createdAt:     '2026-01-01T00:00:00Z',
  },
  {
    firebaseUid:   'uid-recruiter-1',
    email:         'recruiter@enlite.health',
    displayName:   'Recruiter User',
    role:          EnliteRole.RECRUITER,
    department:    null,
    lastLoginAt:   null,
    loginCount:    0,
    createdAt:     '2026-02-01T00:00:00Z',
  },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = EnliteRole.ADMIN;
  mockListAdmins.mockResolvedValue({ admins: MOCK_USERS, total: 2 });
  mockCreateAdmin.mockResolvedValue({
    ...MOCK_USERS[0],
    email:     'new@enlite.health',
    resetLink: 'https://reset.link/test',
  });
  mockUpdateAdminRole.mockResolvedValue({ ...MOCK_USERS[0], role: EnliteRole.RECRUITER });
  mockDeleteAdmin.mockResolvedValue(undefined);
  mockResetPassword.mockResolvedValue({
    resetLink: 'https://reset.link/reset-test',
    message: 'Email enviado',
  });
});

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
  it('renders Rol and Último login column headers', async () => {
    await renderAndWait();
    // Headers come through Typography which renders text directly in DOM
    expect(document.body.textContent).toContain('admin.users.role');
    expect(document.body.textContent).toContain('admin.users.lastLogin');
  });

  it('renders display names in rows', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('Admin User');
    expect(document.body.textContent).toContain('Recruiter User');
  });
});

describe('AdminUsersPage — gating', () => {
  it('shows "Nuevo Usuario" button for admin', async () => {
    await renderAndWait();
    const btn = screen.getByRole('button', { name: 'admin.users.create' });
    expect(btn).toBeInTheDocument();
  });

  it('hides "Nuevo Usuario" button for non-admin', async () => {
    mockRole = EnliteRole.RECRUITER;
    await renderAndWait();
    expect(screen.queryByRole('button', { name: 'admin.users.create' })).not.toBeInTheDocument();
  });

  it('renders role selects for admin viewer', async () => {
    await renderAndWait();
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThan(0);
  });

  it('renders no selects for non-admin viewer', async () => {
    mockRole = EnliteRole.RECRUITER;
    await renderAndWait();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('AdminUsersPage — role change', () => {
  it('calls updateAdminRole and reloads on select change', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    const selects = screen.getAllByRole('combobox');

    await act(async () => {
      await user.selectOptions(selects[0], EnliteRole.RECRUITER);
    });

    await waitFor(() =>
      expect(mockUpdateAdminRole).toHaveBeenCalledWith('uid-admin-1', EnliteRole.RECRUITER),
    );
    // loadAdmins called once on mount, once after role change
    expect(mockListAdmins.mock.calls.length).toBeGreaterThanOrEqual(2);
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

    await waitFor(() =>
      expect(document.body.textContent).toContain('admin.users.invitationFallbackTitle'),
    );
    // Reset link is shown
    expect(document.body.textContent).toContain('https://reset.link/test');
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
});

// ── D269 — célula de escrita, além do role (POST /users, PATCH /:id/role,
// POST /:id/reset-password, DELETE /:id) ───────────────────────────────────

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

describe('AdminUsersPage — D269 célula (enforcement "on")', () => {
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('ADMIN sem NENHUMA célula → Crear/Reset/Eliminar somem e o papel vira badge (fora do DOM, não desabilitado)', async () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
    await renderAndWait();

    expect(screen.queryByRole('button', { name: 'admin.users.create' })).not.toBeInTheDocument();
    expect(screen.queryByText('admin.users.reset')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.users.delete')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('ADMIN com as 3 células (user_management:write/delete + permission_management:write) → tudo aparece', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['user_management:write', 'user_management:delete', 'permission_management:write'], 'on'),
    });
    await renderAndWait();

    expect(screen.getByRole('button', { name: 'admin.users.create' })).toBeInTheDocument();
    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
  });

  it('RECRUITER (não-admin) com user_management:write → "Reset" aparece (célula, não role) mas Crear/Eliminar/papel continuam fora (isAdmin preservado)', async () => {
    mockRole = EnliteRole.RECRUITER;
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['user_management:write', 'user_management:delete', 'permission_management:write'], 'on'),
    });
    await renderAndWait();

    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'admin.users.create' })).not.toBeInTheDocument();
    expect(screen.queryByText('admin.users.delete')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('ADMIN sem user_management:write especificamente → só o "Reset" some (as outras células ainda concedidas)', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['user_management:delete', 'permission_management:write'], 'on'),
    });
    await renderAndWait();

    expect(screen.queryByText('admin.users.reset')).not.toBeInTheDocument();
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
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

  it('mostra o erro quando resetPassword falha', async () => {
    const user = userEvent.setup();
    mockResetPassword.mockRejectedValueOnce(new Error('reset boom'));
    await renderAndWait();

    await user.click(screen.getAllByText('admin.users.reset')[0]);

    await waitFor(() => expect(document.body.textContent).toContain('reset boom'));
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

  it('mostra o erro quando updateAdminRole falha', async () => {
    const user = userEvent.setup();
    mockUpdateAdminRole.mockRejectedValueOnce(new Error('role boom'));
    await renderAndWait();

    const selects = screen.getAllByRole('combobox');
    await act(async () => {
      await user.selectOptions(selects[0], EnliteRole.RECRUITER);
    });

    await waitFor(() => expect(document.body.textContent).toContain('role boom'));
  });
});

describe('AdminUsersPage — D269 sem contrato/enforcement "off": comportamento atual (por role) continua', () => {
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('ADMIN sem contrato nenhum (authz null) → Crear/Reset/Eliminar/papel continuam visíveis, como antes da D269', async () => {
    await renderAndWait();

    expect(screen.getByRole('button', { name: 'admin.users.create' })).toBeInTheDocument();
    expect(screen.getAllByText('admin.users.reset').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.users.delete').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
  });
});
