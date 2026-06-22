/**
 * MergeAdvancedFields.test.tsx
 *
 * Covers:
 * (a) returns null / does NOT render "Avanzado" when no field has has_conflict
 * (b) lists ONLY conflicting fields (not non-conflicting ones)
 * (c) encrypted field → button disabled, shows 🔒, raw value NOT in DOM,
 *     aria-label = 'Campo cifrado' (defaultValue used by i18n key)
 * (d) field-level choice change → onFieldChoiceChange called with correct args
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MergeAdvancedFields } from './MergeAdvancedFields';
import type { DedupFieldComparison, DedupAccount } from '@domain/entities/DedupGroup';

// i18n uses defaultValue fallback (no translations loaded in test setup)

const ACCOUNT_A: DedupAccount = {
  id: 'acc-A',
  email: 'a@test.com',
  tier: 'REGISTERED',
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  wja_count: 2,
  docs_count: 1,
  encuadres_count: 0,
  login_real: true,
};

const ACCOUNT_B: DedupAccount = {
  id: 'acc-B',
  email: null,
  tier: 'INCOMPLETE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
};

const ACCOUNTS = [ACCOUNT_A, ACCOUNT_B];

/** Field with no conflict */
const FIELD_NO_CONFLICT: DedupFieldComparison = {
  field: 'email',
  values: { 'acc-A': 'a@test.com', 'acc-B': null },
  is_encrypted: false,
  has_conflict: false,
};

/** Field with conflict, not encrypted */
const FIELD_CONFLICT_PLAIN: DedupFieldComparison = {
  field: 'firstName',
  values: { 'acc-A': 'María', 'acc-B': 'Maria' },
  is_encrypted: false,
  has_conflict: true,
};

/** Field with conflict, encrypted */
const FIELD_CONFLICT_ENCRYPTED: DedupFieldComparison = {
  field: 'documentNumber',
  values: { 'acc-A': null, 'acc-B': null },
  is_encrypted: true,
  has_conflict: true,
};

function renderComponent(
  props: Partial<{
    fieldComparisons: DedupFieldComparison[];
    accounts: DedupAccount[];
    survivorId: string;
    fieldChoices: Record<string, string>;
    onFieldChoiceChange: (field: string, accountId: string) => void;
  }> = {},
) {
  const defaults = {
    fieldComparisons: [FIELD_NO_CONFLICT, FIELD_CONFLICT_PLAIN],
    accounts: ACCOUNTS,
    survivorId: 'acc-A',
    fieldChoices: {},
    onFieldChoiceChange: vi.fn(),
  };
  return render(<MergeAdvancedFields {...defaults} {...props} />);
}

describe('MergeAdvancedFields — (a) no conflicts → renders nothing', () => {
  it('returns null when no field has has_conflict=true', () => {
    const { container } = renderComponent({
      fieldComparisons: [FIELD_NO_CONFLICT],
    });
    expect(container.firstChild).toBeNull();
  });

  it('returns null when fieldComparisons is empty', () => {
    const { container } = renderComponent({ fieldComparisons: [] });
    expect(container.firstChild).toBeNull();
  });

  it('does NOT render "Avanzado" label when no conflicts', () => {
    renderComponent({ fieldComparisons: [FIELD_NO_CONFLICT] });
    expect(screen.queryByText(/Avanzado/i)).not.toBeInTheDocument();
  });
});

describe('MergeAdvancedFields — (b) lists only conflicting fields', () => {
  it('renders the collapsible container when at least one conflict exists', () => {
    const { container } = renderComponent({
      fieldComparisons: [FIELD_NO_CONFLICT, FIELD_CONFLICT_PLAIN],
    });
    expect(container.firstChild).not.toBeNull();
  });

  it('toggle button shows "Avanzado" and conflict count', () => {
    renderComponent({ fieldComparisons: [FIELD_CONFLICT_PLAIN] });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Avanzado');
    // defaultValue includes the count
    expect(toggle.textContent).toContain('1');
  });

  it('only conflicting field names appear after opening', async () => {
    renderComponent({ fieldComparisons: [FIELD_NO_CONFLICT, FIELD_CONFLICT_PLAIN] });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });

    // 'firstName' field should show, 'email' should not
    expect(document.body.textContent).toContain('firstName');
    // email is not conflicting so should not be in expanded content
    // (the field label renders the field key as defaultValue)
    const fieldLabels = document.querySelectorAll('.px-4.py-3 span');
    const texts = Array.from(fieldLabels).map((el) => el.textContent);
    expect(texts.some((t) => t?.includes('firstName'))).toBe(true);
    expect(texts.every((t) => !t?.includes('email') || t?.includes('firstName'))).toBe(true);
  });
});

describe('MergeAdvancedFields — (c) encrypted field behaviour', () => {
  beforeEach(async () => {
    renderComponent({
      fieldComparisons: [FIELD_CONFLICT_ENCRYPTED],
      accounts: ACCOUNTS,
    });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });
  });

  it('encrypted field buttons are disabled', () => {
    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    expect(accountButtons.length).toBeGreaterThan(0);
    accountButtons.forEach((btn) => {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('encrypted field shows 🔒 icon (Lock from lucide + emoji fallback)', () => {
    // The component renders the Lock lucide icon AND the 🔒 emoji text
    expect(document.body.textContent).toContain('🔒');
  });

  it('raw value is NEVER in the DOM for encrypted field', () => {
    // values are null for encrypted, but the raw null value should not render as meaningful text
    // The component renders '🔒' instead of rawValue
    // Ensure no "null" string leaks into DOM
    expect(document.body.textContent).not.toContain('null');
    // Ensure neither "María" nor "Maria" appear (from a hypothetical plaintext value)
    expect(document.body.textContent).not.toContain('María');
    expect(document.body.textContent).not.toContain('Maria');
  });

  it('aria-label of encrypted button is "Campo cifrado" (defaultValue)', () => {
    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    const ariaLabels = Array.from(accountButtons).map((b) => b.getAttribute('aria-label'));
    expect(ariaLabels.every((label) => label === 'Campo cifrado')).toBe(true);
  });
});

describe('MergeAdvancedFields — (d) field-level choice change', () => {
  it('clicking a non-encrypted account button calls onFieldChoiceChange with field + accountId', async () => {
    const onFieldChoiceChange = vi.fn();
    renderComponent({
      fieldComparisons: [FIELD_CONFLICT_PLAIN],
      accounts: ACCOUNTS,
      onFieldChoiceChange,
    });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });

    // Find the button for account-B (not the survivor)
    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    // Click the second button (acc-B)
    await act(async () => { fireEvent.click(accountButtons[1]); });

    expect(onFieldChoiceChange).toHaveBeenCalledWith('firstName', 'acc-B');
  });

  it('clicking an encrypted account button does NOT call onFieldChoiceChange', async () => {
    const onFieldChoiceChange = vi.fn();
    renderComponent({
      fieldComparisons: [FIELD_CONFLICT_ENCRYPTED],
      accounts: ACCOUNTS,
      onFieldChoiceChange,
    });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });

    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    await act(async () => { fireEvent.click(accountButtons[0]); });

    expect(onFieldChoiceChange).not.toHaveBeenCalled();
  });

  it('toggling open/close works (aria-expanded flips)', async () => {
    renderComponent({ fieldComparisons: [FIELD_CONFLICT_PLAIN] });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

// ── (e) plural "conflictos" label when count > 1 (line 52 plural branch) ─────

describe('MergeAdvancedFields — (e) plural conflict label (line 52)', () => {
  it('renders plural "conflictos" in toggle when 2+ conflicts exist', () => {
    const FIELD_CONFLICT_2: typeof FIELD_CONFLICT_PLAIN = {
      field: 'lastName',
      values: { 'acc-A': 'García', 'acc-B': 'Garcia' },
      is_encrypted: false,
      has_conflict: true,
    };
    renderComponent({
      fieldComparisons: [FIELD_CONFLICT_PLAIN, FIELD_CONFLICT_2],
    });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    // defaultValue with count=2: "conflictos" (plural with 's')
    expect(toggle.textContent).toContain('conflictos');
    expect(toggle.textContent).toContain('2');
  });
});
