import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AreaMembershipsSection } from '../AreaMembershipsSection';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { ApiError } from '@infrastructure/http/ApiError';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = { list: vi.fn(), grant: vi.fn(), revoke: vi.fn() };
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listAreaMemberships: (...a: unknown[]) => api.list(...a),
    grantAreaMembership: (...a: unknown[]) => api.grant(...a),
    revokeAreaMembership: (...a: unknown[]) => api.revoke(...a),
  },
}));

const PID = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const LIST = {
  personId: PID,
  memberships: [{ id: MID, personId: PID, area: 'learn', role: 'teacher', grantedBy: 'uid-staff', grantedAt: '2026-11-01T12:00:00.000Z' }],
};

function cells(permissions: string[]): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
  });
}

async function search(value = PID): Promise<void> {
  await userEvent.type(screen.getByLabelText('admin.access.areaMemberships.search.value'), value);
  await userEvent.click(screen.getByRole('button', { name: 'admin.access.areaMemberships.search.submit' }));
}

describe('AreaMembershipsSection', () => {
  beforeEach(() => {
    api.list.mockReset().mockResolvedValue(LIST);
    api.grant.mockReset().mockResolvedValue({});
    api.revoke.mockReset().mockResolvedValue({});
  });

  it('🔴 sem `area_membership:read` a seção NÃO existe no DOM e não chama a API', () => {
    cells(['permission_management:read', 'permission_management:write']);
    const { container } = render(<AreaMembershipsSection />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('area-memberships-section')).not.toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('contrato carregando ou em erro: a seção não existe (fail-closed)', () => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'loading' });
    const { container, rerender } = render(<AreaMembershipsSection />);
    expect(container).toBeEmptyDOMElement();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'error' });
    rerender(<AreaMembershipsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('read: mostra o convite, busca por personId e lista; sem ações de conceder/revogar', async () => {
    cells(['area_membership:read']);
    render(<AreaMembershipsSection />);
    expect(screen.getByText('admin.access.areaMemberships.prompt')).toBeInTheDocument();
    await search();
    expect(await screen.findByText('uid-staff')).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith({ personId: PID });
    expect(screen.getByText('admin.access.areaMemberships.roles.teacher')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'admin.access.areaMemberships.revoke.open' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('area-membership-grant-form')).not.toBeInTheDocument();
  });

  it('busca por uid manda `{ uid }`', async () => {
    cells(['area_membership:read']);
    render(<AreaMembershipsSection />);
    await userEvent.selectOptions(screen.getByLabelText('admin.access.areaMemberships.search.mode'), 'uid');
    await search('firebase-uid-1');
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ uid: 'firebase-uid-1' }));
  });

  it('estados: carregando, vazio e erro (404 e falha genérica)', async () => {
    cells(['area_membership:read']);
    let resolve!: (v: unknown) => void;
    api.list.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<AreaMembershipsSection />);
    await search();
    expect(await screen.findByRole('status')).toHaveTextContent('admin.access.areaMemberships.loading');
    resolve({ personId: PID, memberships: [] });
    expect(await screen.findByText('admin.access.areaMemberships.empty')).toBeInTheDocument();

    api.list.mockRejectedValueOnce(new ApiError({ success: false, error: 'x' }, 404));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.areaMemberships.search.submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.areaMemberships.errors.notFound');

    api.list.mockRejectedValueOnce(new Error('rede'));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.areaMemberships.search.submit' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('admin.access.areaMemberships.errors.load'));
  });

  it('write: concede com o corpo certo (par válido da área) e recarrega', async () => {
    cells(['area_membership:read', 'area_membership:write']);
    render(<AreaMembershipsSection />);
    await search();
    await screen.findByText('uid-staff');
    // trocar de área reinicia o papel para um par válido: care só admite family
    await userEvent.selectOptions(screen.getByLabelText('admin.access.areaMemberships.grant.area'), 'care');
    const roles = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(roles).toContain('family');
    expect(roles).not.toContain('teacher');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.areaMemberships.grant.submit' }));
    await waitFor(() => expect(api.grant).toHaveBeenCalledWith({ personId: PID, area: 'care', role: 'family' }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ personId: PID }));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('write: conceder recusado (422) mostra o erro de par e não recarrega', async () => {
    cells(['area_membership:read', 'area_membership:write']);
    api.grant.mockRejectedValue(new ApiError({ success: false, error: 'par' }, 422));
    render(<AreaMembershipsSection />);
    await search();
    await screen.findByText('uid-staff');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.areaMemberships.grant.submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.areaMemberships.errors.grantRejected');
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('write: revogar fica BLOQUEADO sem motivo; com motivo chama a API com id e motivo e recarrega', async () => {
    cells(['area_membership:read', 'area_membership:write']);
    render(<AreaMembershipsSection />);
    await search();
    await userEvent.click(await screen.findByRole('button', { name: 'admin.access.areaMemberships.revoke.open' }));
    const confirm = screen.getByRole('button', { name: 'admin.access.areaMemberships.revoke.confirm' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('admin.access.areaMemberships.revoke.reason'), '   ');
    expect(confirm).toBeDisabled();
    expect(api.revoke).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('admin.access.areaMemberships.revoke.reason'), 'saiu da equipe');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith(MID, 'saiu da equipe'));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('write: revogar vínculo já revogado (404) mostra o aviso próprio', async () => {
    cells(['area_membership:read', 'area_membership:write']);
    api.revoke.mockRejectedValue(new ApiError({ success: false, error: 'gone' }, 404));
    render(<AreaMembershipsSection />);
    await search();
    await userEvent.click(await screen.findByRole('button', { name: 'admin.access.areaMemberships.revoke.open' }));
    await userEvent.type(screen.getByLabelText('admin.access.areaMemberships.revoke.reason'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.areaMemberships.revoke.confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.access.areaMemberships.errors.revokeGone');
  });
});
