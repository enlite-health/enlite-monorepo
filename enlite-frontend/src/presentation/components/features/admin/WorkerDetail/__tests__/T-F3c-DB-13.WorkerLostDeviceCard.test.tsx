/**
 * T-F3c-DB-13 — botão "Celular perdido" (spec 077, D795). Componente: a célula `worker_device:revoke` decide se ele
 * EXISTE (com o engine desligado também: `useHasCell`, não `useActionGate`); confirmação antes de chamar; depois do
 * clique a linha de status vem de uma NOVA leitura do servidor. O e2e de tela mora em `e2e/` (roda no CI).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { WorkerDeviceStatus } from '@domain/entities/WorkerDevice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'es' } }),
}));

const mockGetStatus = vi.fn();
const mockRevoke = vi.fn();
vi.mock('@infrastructure/http/AdminWorkerDeviceApiService', () => ({
  AdminWorkerDeviceApiService: {
    getStatus: (...a: unknown[]) => mockGetStatus(...a),
    revoke: (...a: unknown[]) => mockRevoke(...a),
  },
}));

import { WorkerLostDeviceCard } from '../WorkerLostDeviceCard';

const ATIVO: WorkerDeviceStatus = { hasActiveDevice: true, lastOperatorRevocation: null };
const PEDIDO: WorkerDeviceStatus = {
  hasActiveDevice: false,
  lastOperatorRevocation: { revokedAt: '2026-11-24T15:00:00.000Z', wipedAt: null, requestedByName: 'Ana Operadora' },
};

function comPermissoes(permissions: string[], enforcement: 'on' | 'off') {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

describe('T-F3c-DB-13 WorkerLostDeviceCard', () => {
  beforeEach(() => {
    mockGetStatus.mockReset();
    mockRevoke.mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('T-F3c-DB-13 sem a célula worker_device:revoke o botão não existe (nem com o engine desligado) e o status nem é pedido', async () => {
    comPermissoes(['worker:read', 'worker:update'], 'off');
    mockGetStatus.mockResolvedValue(ATIVO);
    const { container } = render(<WorkerLostDeviceCard workerId="w-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('worker-lost-device-button')).toBeNull();
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('T-F3c-DB-13 pede confirmação antes de chamar: abrir e cancelar não revoga; só o "sí" chama a rota', async () => {
    comPermissoes(['worker_device:revoke'], 'on');
    mockGetStatus.mockResolvedValue(ATIVO);
    mockRevoke.mockResolvedValue({ deviceId: 'd-1', sessionsRevoked: true, pushSent: true });
    const user = userEvent.setup();
    render(<WorkerLostDeviceCard workerId="w-1" />);

    await user.click(await screen.findByTestId('worker-lost-device-button'));
    expect(screen.getByTestId('lost-device-confirm')).toBeInTheDocument();
    expect(mockRevoke).not.toHaveBeenCalled();

    await user.click(screen.getByText('admin.workerDetail.lostDevice.cancel', { selector: 'button' }));
    expect(screen.queryByTestId('lost-device-confirm')).toBeNull();
    expect(mockRevoke).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('worker-lost-device-button'));
    await user.click(screen.getByTestId('lost-device-confirm-button'));
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledTimes(1));
    expect(mockRevoke).toHaveBeenCalledWith('w-1');
  });

  it('T-F3c-DB-13 clique → pedido → a linha de status vem de uma nova leitura do servidor (quem pediu e quando)', async () => {
    comPermissoes(['worker_device:revoke'], 'on');
    mockGetStatus.mockResolvedValueOnce(ATIVO).mockResolvedValueOnce(PEDIDO);
    mockRevoke.mockResolvedValue({ deviceId: 'd-1', sessionsRevoked: true, pushSent: true });
    const user = userEvent.setup();
    render(<WorkerLostDeviceCard workerId="w-1" />);

    expect(screen.queryByTestId('lost-device-status')).toBeNull();
    await user.click(await screen.findByTestId('worker-lost-device-button'));
    await user.click(screen.getByTestId('lost-device-confirm-button'));

    expect(await screen.findByTestId('lost-device-status')).toBeInTheDocument();
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('lost-device-pending')).toBeInTheDocument();
    // sem aparelho ativo depois do pedido, o botão some; a revogação continua à vista
    expect(screen.queryByTestId('worker-lost-device-button')).toBeNull();
  });
});
