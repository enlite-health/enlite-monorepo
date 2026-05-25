/**
 * InviteProgressModal.test.tsx
 *
 * Testes unitários do InviteProgressModal:
 *   - Dispara envio automático quando não há candidatos já notificados
 *   - Exibe tela de confirmação de re-envio quando há candidatos já notificados
 *   - Renderiza lista de progresso após iniciar envio
 *   - Botão "Sólo nuevos" dispara apenas candidatos sem messagedAt
 *   - Botão "Reenviar a todos" dispara todos os candidatos
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InviteProgressModal } from './InviteProgressModal';
import type { SavedCandidate } from '../../../../../types/match';

// ── i18n mock ─────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'admin.messaging.title':                        'Enviar invitación',
        'admin.messaging.alreadyReceivedMessage':       `${opts?.count ?? ''} worker ya recibió este mensaje.`,
        'admin.messaging.notYetReceived':               `${opts?.count ?? ''} todavía no la recibió.`,
        'admin.messaging.confirmResendQuestion':        '¿Deseás reenviarla?',
        'admin.messaging.newOnly':                      `Sólo nuevos (${opts?.count ?? ''})`,
        'admin.messaging.resendAll':                    'Reenviar a todos',
        'admin.messaging.statusSent':                   '✓ enviado',
        'admin.messaging.statusErrorPrefix':            '✗ ',
        'admin.messaging.statusErrorFallback':          'error',
        'admin.messaging.statusSending':                '…enviando',
        'admin.messaging.statusWaiting':                'esperando',
        'admin.messaging.sending':                      'Enviando…',
        'admin.messaging.doneLabel':                    'Completado:',
        'admin.messaging.doneSent':                     `${opts?.count ?? ''} enviado`,
        'admin.messaging.doneErrors':                   `${opts?.count ?? ''} fallido`,
        'common.cancel':                                'Cancelar',
        'common.close':                                 'Cerrar',
      };
      return map[key] ?? key;
    },
  }),
}));

// ── useMatchMessaging mock ────────────────────────────────────────────────────

const mockSendBatch = vi.fn();
const mockResetProgress = vi.fn();

let mockProgress: { workerId: string; workerName: string; status: string; error?: string }[] = [];
let mockIsSending = false;

vi.mock('@hooks/admin/useMatchMessaging', () => ({
  useMatchMessaging: () => ({
    isSending: mockIsSending,
    progress:  mockProgress,
    sendBatch: mockSendBatch,
    resetProgress: mockResetProgress,
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const candidateNew: SavedCandidate = {
  workerId: 'w-001', workerName: 'Maria Sánchez', workerPhone: '+549111',
  occupation: 'AT', workZone: 'Palermo', distanceKm: 2.1,
  activeCasesCount: 0, overallStatus: 'REGISTERED', matchScore: 87,
  internalNotes: null,
  alreadyApplied: false, messagedAt: null,
};

const candidateAlreadyNotified: SavedCandidate = {
  workerId: 'w-002', workerName: 'Ana Rodríguez', workerPhone: '+549222',
  occupation: 'AT', workZone: 'Caballito', distanceKm: 4.3,
  activeCasesCount: 1, overallStatus: 'REGISTERED', matchScore: 74,
  internalNotes: null,
  alreadyApplied: false, messagedAt: '2026-03-25T10:00:00Z',
};

function renderModal(
  candidates: SavedCandidate[],
  onClose = vi.fn(),
  onMessaged = vi.fn(),
) {
  return render(
    <InviteProgressModal
      candidates={candidates}
      vacancyId="vac-001"
      onClose={onClose}
      onMessaged={onMessaged}
    />,
  );
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('InviteProgressModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProgress = [];
    mockIsSending = false;
  });

  it('dispara sendBatch automaticamente quando nenhum candidato foi notificado', () => {
    renderModal([candidateNew]);

    expect(mockSendBatch).toHaveBeenCalledOnce();
    expect(mockSendBatch).toHaveBeenCalledWith(
      [candidateNew],
      expect.any(Function),
    );
  });

  it('não dispara sendBatch automaticamente quando há candidato já notificado', () => {
    renderModal([candidateAlreadyNotified, candidateNew]);

    // NÃO deve disparar sendBatch sem confirmação do operador
    expect(mockSendBatch).not.toHaveBeenCalled();
  });

  it('exibe mensagem de aviso de re-envio quando há candidato já notificado', () => {
    renderModal([candidateAlreadyNotified, candidateNew]);

    expect(screen.getByText(/ya recibió este mensaje/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sólo nuevos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reenviar a todos/i })).toBeInTheDocument();
  });

  it('"Reenviar a todos" chama sendBatch com todos os candidatos', async () => {
    renderModal([candidateAlreadyNotified, candidateNew]);

    fireEvent.click(screen.getByRole('button', { name: /Reenviar a todos/i }));

    await waitFor(() => {
      expect(mockSendBatch).toHaveBeenCalledWith(
        [candidateAlreadyNotified, candidateNew],
        expect.any(Function),
      );
    });
  });

  it('"Sólo nuevos" chama sendBatch somente com candidatos sem messagedAt', async () => {
    renderModal([candidateAlreadyNotified, candidateNew]);

    fireEvent.click(screen.getByRole('button', { name: /Sólo nuevos/i }));

    await waitFor(() => {
      expect(mockSendBatch).toHaveBeenCalledWith(
        [candidateNew],
        expect.any(Function),
      );
    });
  });

  it('renderiza lista de progresso quando progress tem itens', () => {
    mockProgress = [
      { workerId: 'w-001', workerName: 'Maria Sánchez', status: 'sent' },
      { workerId: 'w-002', workerName: 'Ana Rodríguez', status: 'pending' },
    ];

    renderModal([candidateNew, candidateAlreadyNotified]);

    expect(screen.getByText('Maria Sánchez')).toBeInTheDocument();
    expect(screen.getByText('Ana Rodríguez')).toBeInTheDocument();
    expect(screen.getByText('✓ enviado')).toBeInTheDocument();
    expect(screen.getByText('esperando')).toBeInTheDocument();
  });

  it('botão fechar chama onClose e resetProgress', () => {
    const onClose = vi.fn();
    renderModal([candidateNew], onClose);

    fireEvent.click(screen.getByRole('button', { name: /Cerrar/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(mockResetProgress).toHaveBeenCalledOnce();
  });
});
