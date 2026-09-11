/**
 * IncompleteRegistrationModal.test.tsx
 *
 * Verifica que cada item da lista vira um link clicável que navega para
 * a URL correta (/worker/profile?tab=<tab>&focus=<focus>) e fecha o modal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { IncompleteRegistrationModal } from './IncompleteRegistrationModal';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
const mockOnClose = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // Return the defaultValue if given (for field tokens)
      if (opts && typeof opts['defaultValue'] === 'string') return opts['defaultValue'];
      // Simulate goToField interpolation
      if (key === 'publicVacancy.incompleteModal.goToField' && opts?.field) {
        return `Ir a ${opts.field}`;
      }
      // Return last segment of key as a recognizable string
      return key.split('.').pop() ?? key;
    },
    i18n: { language: 'es' },
  }),
}));

vi.mock('@presentation/components/atoms/Heading', () => ({
  Heading: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

vi.mock('@presentation/components/atoms/Text', () => ({
  Text: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

vi.mock('@presentation/components/atoms/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderModal(missingFields: string[] | null) {
  return render(
    <IncompleteRegistrationModal
      missingFields={missingFields}
      onClose={mockOnClose}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockNavigate.mockClear();
  mockOnClose.mockClear();
});

describe('IncompleteRegistrationModal — navegação por item', () => {
  it('clicar em item de doc (doc_resume_cv) navega para ?tab=documents&focus=resume_cv e fecha modal', () => {
    renderModal(['doc_resume_cv']);

    // O item é um button com o texto do campo
    const item = screen.getByRole('button', { name: /resume_cv/i });
    fireEvent.click(item);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=documents&focus=resume_cv');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('clicar em item de campo geral (phone) navega para ?tab=general&focus=phone e fecha modal', () => {
    renderModal(['phone']);

    const item = screen.getByRole('button', { name: /phone/i });
    fireEvent.click(item);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=general&focus=phone');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('clicar em first_name navega para ?tab=general&focus=fullName', () => {
    renderModal(['first_name']);

    const item = screen.getByRole('button', { name: /first_name/i });
    fireEvent.click(item);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=general&focus=fullName');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('clicar em doc_criminal_record navega para ?tab=documents&focus=criminal_record', () => {
    renderModal(['doc_criminal_record']);

    const item = screen.getByRole('button', { name: /criminal_record/i });
    fireEvent.click(item);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=documents&focus=criminal_record');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('clicar em worker_documents (token cru do GET /workers/me, não expandido) navega para ?tab=documents (sem focus)', () => {
    renderModal(['worker_documents']);

    const item = screen.getByRole('button', { name: /worker_documents/i });
    fireEvent.click(item);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=documents');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('clicar em worker_service_areas navega para ?tab=address (sem focus)', () => {
    renderModal(['worker_service_areas']);

    const item = screen.getByRole('button', { name: /worker_service_areas/i });
    fireEvent.click(item);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=address');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});

describe('IncompleteRegistrationModal — botão "Completar registro"', () => {
  it('com só doc pendente: botão navega para firstPendingTab=documents', () => {
    renderModal(['doc_resume_cv']);

    // Find the "confirm" button (not a field button)
    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    fireEvent.click(confirmBtn);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=documents');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('com campo geral + doc pendente: botão navega para firstPendingTab=general', () => {
    renderModal(['doc_resume_cv', 'first_name']);

    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    fireEvent.click(confirmBtn);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=general');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('com missingFields=[] (isEmpty): botão navega para firstPendingTab=general (fallback)', () => {
    renderModal([]);

    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    fireEvent.click(confirmBtn);

    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=general');
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});

describe('IncompleteRegistrationModal — Clarity (LEX C3)', () => {
  it('lista de pendências vem com data-clarity-mask="True" (sessão do Clarity não pode gravar o que falta)', () => {
    renderModal(['phone', 'doc_resume_cv']);

    const maskedList = screen.getByTestId('incomplete-modal-pending-list');
    expect(maskedList).toHaveAttribute('data-clarity-mask', 'True');
    // O item nomeado está DENTRO do contêiner mascarado, não fora dele.
    expect(maskedList).toContainElement(screen.getByRole('button', { name: /phone/i }));
  });
});

describe('IncompleteRegistrationModal — estado vazio', () => {
  it('missingFields=null: nenhuma seção de campos; sem erro', () => {
    renderModal(null);

    // Sem listas de items
    expect(screen.queryAllByRole('button', { name: /Ir a/i })).toHaveLength(0);
  });

  it('missingFields=[]: sem campo listado, bodyGeneric visível', () => {
    renderModal([]);

    expect(screen.queryAllByRole('button', { name: /Ir a/i })).toHaveLength(0);
    // bodyGeneric key returned by mock
    expect(screen.getByText('bodyGeneric')).toBeInTheDocument();
  });
});
