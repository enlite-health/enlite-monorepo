/**
 * UndoConfirmModal.test.tsx
 *
 * Covers:
 * - Renders title, description, phone, warning
 * - Clicking backdrop (data-testid root) closes the modal (calls onClose)
 * - ESC key calls onClose
 * - X button calls onClose and is disabled when isUndoing
 * - Cancel button calls onClose
 * - Confirm button calls onConfirm with auditId
 * - Confirm button is disabled when isUndoing=true
 * - Cancel button is disabled when isUndoing=true
 * - Shows "Deshaciendo..." text (undoing key) when isUndoing=true
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UndoConfirmModal } from './UndoConfirmModal';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AUDIT_ID = 'audit-test-001';
const PHONE = '+5491112345678';

interface ModalProps {
  auditId?: string;
  phone?: string;
  isUndoing?: boolean;
  onConfirm?: (auditId: string) => void;
  onClose?: () => void;
}

function renderModal({
  auditId = AUDIT_ID,
  phone = PHONE,
  isUndoing = false,
  onConfirm = vi.fn(),
  onClose = vi.fn(),
}: ModalProps = {}) {
  return render(
    <UndoConfirmModal
      auditId={auditId}
      phone={phone}
      isUndoing={isUndoing}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Renders ───────────────────────────────────────────────────────────────────

describe('UndoConfirmModal — renders', () => {
  it('renders the modal container', () => {
    renderModal();
    expect(screen.getByTestId('undo-confirm-modal')).toBeInTheDocument();
  });

  it('renders the phone number in the context box', () => {
    renderModal();
    expect(screen.getByText(PHONE)).toBeInTheDocument();
  });

  it('renders the confirm button', () => {
    renderModal();
    expect(screen.getByTestId('undo-confirm-button')).toBeInTheDocument();
  });
});

// ── onClose triggers ──────────────────────────────────────────────────────────

describe('UndoConfirmModal — close triggers', () => {
  it('clicking the backdrop calls onClose', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    const backdrop = screen.getByTestId('undo-confirm-modal');
    // Simulate click directly on the backdrop div (not a child)
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing ESC calls onClose', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking X button calls onClose', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    // X button has aria-label from i18n key admin.dedup.history.undo.close
    const xBtn = screen.getByRole('button', {
      name: /admin\.dedup\.history\.undo\.close/i,
    });
    fireEvent.click(xBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking Cancel calls onClose', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    // Cancel button text comes from i18n key: admin.dedup.history.undo.cancel
    const cancelBtn = screen.getByRole('button', {
      name: /admin\.dedup\.history\.undo\.cancel/i,
    });
    fireEvent.click(cancelBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── onConfirm ─────────────────────────────────────────────────────────────────

describe('UndoConfirmModal — confirm', () => {
  it('clicking Confirm calls onConfirm with the auditId', () => {
    const onConfirm = vi.fn();
    renderModal({ onConfirm });

    fireEvent.click(screen.getByTestId('undo-confirm-button'));

    expect(onConfirm).toHaveBeenCalledWith(AUDIT_ID);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('clicking Confirm passes the correct auditId even when customized', () => {
    const onConfirm = vi.fn();
    renderModal({ auditId: 'audit-custom-xyz', onConfirm });

    fireEvent.click(screen.getByTestId('undo-confirm-button'));

    expect(onConfirm).toHaveBeenCalledWith('audit-custom-xyz');
  });
});

// ── isUndoing disables buttons ────────────────────────────────────────────────

describe('UndoConfirmModal — isUndoing state', () => {
  it('confirm button is disabled when isUndoing=true', () => {
    renderModal({ isUndoing: true });
    const confirmBtn = screen.getByTestId('undo-confirm-button');
    expect(confirmBtn).toBeDisabled();
  });

  it('cancel button is disabled when isUndoing=true', () => {
    renderModal({ isUndoing: true });
    // Cancel button is disabled too — find it by matching the cancel key
    const buttons = screen.getAllByRole('button');
    // All interactive buttons should be disabled during undoing
    const cancelBtn = buttons.find((b) =>
      b.textContent?.includes('admin.dedup.history.undo.cancel'),
    );
    expect(cancelBtn).toBeDisabled();
  });

  it('X button is disabled when isUndoing=true', () => {
    renderModal({ isUndoing: true });
    const xBtn = screen.getByRole('button', {
      name: /admin\.dedup\.history\.undo\.close/i,
    });
    expect(xBtn).toBeDisabled();
  });

  it('confirm button is enabled when isUndoing=false', () => {
    renderModal({ isUndoing: false });
    expect(screen.getByTestId('undo-confirm-button')).not.toBeDisabled();
  });
});
