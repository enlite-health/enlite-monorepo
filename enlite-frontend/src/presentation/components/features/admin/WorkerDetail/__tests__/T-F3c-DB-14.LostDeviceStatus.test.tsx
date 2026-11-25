/**
 * T-F3c-DB-14 — status do "Celular perdido" (spec 077, D795). Decisão do orquestrador (24/11): DOIS estados
 * persistidos, lidos do servidor — "pedido enviado; o servidor ainda não ouviu o celular" (`wipedAt` null) e "o app
 * informou que apagou" (`wipedAt`) — mais o retorno do clique (`pushSent`), que NÃO é guardado nem reconstruído.
 * Textos reais do es.json: "pendente" nunca vira "não apagou", e nada diz "confirmado".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import es from '@infrastructure/i18n/locales/es.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { OperatorRevocation } from '@domain/entities/WorkerDevice';

function t(key: string, opts?: Record<string, string>): string {
  let cur: unknown = es;
  for (const part of key.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part];
  if (typeof cur !== 'string') return key;
  return cur.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => opts?.[k] ?? '');
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'es' } }) }));

const mockGetStatus = vi.fn();
const mockRevoke = vi.fn();
vi.mock('@infrastructure/http/AdminWorkerDeviceApiService', () => ({
  AdminWorkerDeviceApiService: {
    getStatus: (...a: unknown[]) => mockGetStatus(...a),
    revoke: (...a: unknown[]) => mockRevoke(...a),
  },
}));

import { LostDeviceStatus } from '../LostDeviceStatus';
import { WorkerLostDeviceCard } from '../WorkerLostDeviceCard';

const L = (es as unknown as { admin: { workerDetail: { lostDevice: Record<string, string> } } }).admin.workerDetail.lostDevice;
const PEDIDO: OperatorRevocation = { revokedAt: '2026-11-24T15:00:00.000Z', wipedAt: null, requestedByName: 'Ana Operadora' };

describe('T-F3c-DB-14 status do pedido (lido do servidor)', () => {
  beforeEach(() => {
    mockGetStatus.mockReset();
    mockRevoke.mockReset();
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['worker_device:revoke'], countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
    });
  });

  it('T-F3c-DB-14 pedido enviado sem wipedAt: quem pediu e quando + "o servidor ainda não ouviu" (nunca "não apagou")', () => {
    render(<LostDeviceStatus revocation={PEDIDO} />);
    const pedido = screen.getByTestId('lost-device-requested').textContent ?? '';
    expect(pedido).toContain('Ana Operadora');
    expect(pedido).toContain('24/11/2026, 12:00'); // 15:00Z no fuso da operação (Buenos Aires)
    expect(screen.getByTestId('lost-device-pending').textContent).toBe(L.pending);
    expect(L.pending).toMatch(/no significa que no se haya borrado/);
    expect(screen.queryByTestId('lost-device-wiped')).toBeNull();
  });

  it('T-F3c-DB-14 com wipedAt: "la app informó que borró" com a data do servidor, sem a linha de pendente', () => {
    render(<LostDeviceStatus revocation={{ ...PEDIDO, wipedAt: '2026-11-24T18:30:00.000Z' }} />);
    const apagado = screen.getByTestId('lost-device-wiped').textContent ?? '';
    expect(apagado).toContain('La app informó que borró los datos el 24/11/2026, 15:30');
    expect(apagado).not.toMatch(/confirmad/i);
    expect(screen.queryByTestId('lost-device-pending')).toBeNull();
  });

  it('T-F3c-DB-14 o retorno do push aparece só no clique e não é reconstruído ao reabrir a ficha', async () => {
    const depois = { hasActiveDevice: false, lastOperatorRevocation: PEDIDO };
    mockGetStatus.mockResolvedValueOnce({ hasActiveDevice: true, lastOperatorRevocation: null }).mockResolvedValue(depois);
    mockRevoke.mockResolvedValue({ deviceId: 'd-1', sessionsRevoked: true, pushSent: false });
    const user = userEvent.setup();
    const { unmount } = render(<WorkerLostDeviceCard workerId="w-1" />);
    await user.click(await screen.findByTestId('worker-lost-device-button'));
    await user.click(screen.getByTestId('lost-device-confirm-button'));
    await waitFor(() => expect(screen.getByTestId('lost-device-feedback').textContent).toBe(L.pushNotSent));
    unmount();

    render(<WorkerLostDeviceCard workerId="w-1" />);
    expect(await screen.findByTestId('lost-device-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('lost-device-feedback')).toBeNull();
  });
});
