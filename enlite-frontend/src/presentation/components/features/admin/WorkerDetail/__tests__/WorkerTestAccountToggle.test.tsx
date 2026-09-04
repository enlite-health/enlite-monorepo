import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { WorkerTestAccountToggle } from '../WorkerTestAccountToggle';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let mockRole: EnliteRole = EnliteRole.ADMIN;
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: { role: mockRole } }),
}));

const mockUpdate = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updateWorkerTestFlag: (...args: unknown[]) => mockUpdate(...args) },
}));

describe('WorkerTestAccountToggle', () => {
  beforeEach(() => {
    mockRole = EnliteRole.ADMIN;
    mockUpdate.mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('renders nothing for non-admin roles', () => {
    mockRole = EnliteRole.RECRUITER;
    const { container } = render(<WorkerTestAccountToggle workerId="w-1" initialIsTest={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('D269 — enforcement=on sem worker:write: renderiza nada, mesmo admin', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries: [], groups: [], features: {}, enforcement: 'on',
      } as AuthzContract,
    });
    const { container } = render(<WorkerTestAccountToggle workerId="w-1" initialIsTest={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('D269 — enforcement=on com worker:write: renderiza o checkbox', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['worker:write'], countries: [], groups: [], features: {}, enforcement: 'on',
      } as AuthzContract,
    });
    render(<WorkerTestAccountToggle workerId="w-1" initialIsTest={false} />);
    expect(screen.getByTestId('worker-test-account-checkbox')).toBeInTheDocument();
  });

  it('renders the checkbox for admin role', () => {
    render(<WorkerTestAccountToggle workerId="w-1" initialIsTest={false} />);
    const checkbox = screen.getByTestId('worker-test-account-checkbox') as HTMLInputElement;
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.checked).toBe(false);
  });

  it('reflects the initial checked state', () => {
    render(<WorkerTestAccountToggle workerId="w-1" initialIsTest={true} />);
    const checkbox = screen.getByTestId('worker-test-account-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('calls the endpoint and keeps the new state on success', async () => {
    mockUpdate.mockResolvedValue({ isTest: true });
    render(<WorkerTestAccountToggle workerId="w-42" initialIsTest={false} />);
    const checkbox = screen.getByTestId('worker-test-account-checkbox') as HTMLInputElement;

    await userEvent.click(checkbox);

    expect(mockUpdate).toHaveBeenCalledWith('w-42', true);
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it('reverts the state and shows an error when the endpoint fails', async () => {
    mockUpdate.mockRejectedValue(new Error('boom'));
    render(<WorkerTestAccountToggle workerId="w-1" initialIsTest={false} />);
    const checkbox = screen.getByTestId('worker-test-account-checkbox') as HTMLInputElement;

    await userEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(screen.getByText('admin.workerDetail.testAccount.error')).toBeInTheDocument();
  });
});
