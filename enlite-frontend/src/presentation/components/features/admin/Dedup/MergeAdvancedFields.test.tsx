/**
 * MergeAdvancedFields.test.tsx
 *
 * Covers:
 * (a) returns null / does NOT render "Avanzado" when no field has has_conflict
 * (b) lists ONLY conflicting fields (not non-conflicting ones)
 * (c) encrypted field → shows DECRYPTED value + discreet 🔒, selectable
 *     (admin-only endpoint already decrypts; lock is only a "sensitive" marker)
 * (d) field-level choice change → onFieldChoiceChange called with correct args
 * (f) sex/gender enum value rendered via i18n (sex_encrypted)
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

/**
 * Field with conflict, encrypted. Backend now DECRYPTS the value (admin-only),
 * so values are present plaintext — the lock is just a "sensitive" marker.
 */
const FIELD_CONFLICT_ENCRYPTED: DedupFieldComparison = {
  field: 'document_number_encrypted',
  values: { 'acc-A': '20111222333', 'acc-B': '27444555666' },
  is_encrypted: true,
  has_conflict: true,
};

/** Encrypted enum field (sex) — value rendered via i18n */
const FIELD_CONFLICT_SEX: DedupFieldComparison = {
  field: 'sex_encrypted',
  values: { 'acc-A': 'MALE', 'acc-B': 'FEMALE' },
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

  it('encrypted field buttons are ENABLED (selectable)', () => {
    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    expect(accountButtons.length).toBeGreaterThan(0);
    accountButtons.forEach((btn) => {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('shows the DECRYPTED value (not just a lock)', () => {
    expect(document.body.textContent).toContain('20111222333');
    expect(document.body.textContent).toContain('27444555666');
  });

  it('renders a discreet Lock marker on encrypted buttons', () => {
    // lucide Lock renders an <svg> inside each account button
    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    accountButtons.forEach((btn) => {
      expect(btn.querySelector('svg')).not.toBeNull();
    });
  });

  it('aria-label of encrypted button includes the decrypted value', () => {
    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    const ariaLabels = Array.from(accountButtons).map((b) => b.getAttribute('aria-label'));
    expect(ariaLabels.some((label) => label?.includes('20111222333'))).toBe(true);
    expect(ariaLabels.some((label) => label?.includes('27444555666'))).toBe(true);
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

  it('clicking an ENCRYPTED account button DOES call onFieldChoiceChange', async () => {
    const onFieldChoiceChange = vi.fn();
    renderComponent({
      fieldComparisons: [FIELD_CONFLICT_ENCRYPTED],
      accounts: ACCOUNTS,
      onFieldChoiceChange,
    });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });

    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    await act(async () => { fireEvent.click(accountButtons[1]); });

    expect(onFieldChoiceChange).toHaveBeenCalledWith('document_number_encrypted', 'acc-B');
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

// ── (f) sex/gender enum value rendered via i18n (not the raw enum) ───────────

describe('MergeAdvancedFields — (f) enum field rendered via i18n', () => {
  it('sex_encrypted MALE/FEMALE go through the i18n label resolver, not raw enum', async () => {
    renderComponent({
      fieldComparisons: [FIELD_CONFLICT_SEX],
      accounts: ACCOUNTS,
    });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });

    // The resolver maps MALE/FEMALE (lowercased) to the worker-detail i18n keys.
    // No translations are loaded in tests, so the resolved i18n KEY is rendered
    // — proving the raw enum is NOT shown verbatim.
    expect(document.body.textContent).toContain('workerRegistration.generalInfo.male');
    expect(document.body.textContent).toContain('workerRegistration.generalInfo.female');
    expect(document.body.textContent).not.toContain('MALE');
    expect(document.body.textContent).not.toContain('FEMALE');
  });

  it('encrypted enum field is selectable (calls onFieldChoiceChange)', async () => {
    const onFieldChoiceChange = vi.fn();
    renderComponent({
      fieldComparisons: [FIELD_CONFLICT_SEX],
      accounts: ACCOUNTS,
      onFieldChoiceChange,
    });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });

    const accountButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    await act(async () => { fireEvent.click(accountButtons[1]); });

    expect(onFieldChoiceChange).toHaveBeenCalledWith('sex_encrypted', 'acc-B');
  });
});

// ── (g) enum mistos reais de prod — valores ES/EN em caixa mista ──────────────
//
// Prod tem valores como "mujer", "Hombre", "Varón", "Femenino", "Masculino"
// (importados em ES) misturados com "male"/"female" (EN canônico).
// O resolve() faz .toLowerCase() antes do lookup, portanto o mapa precisa cobrir
// todas as variantes minúsculas.

describe('MergeAdvancedFields — (g) prod mixed-case ES/EN enum values', () => {
  /** Helper: renderiza, expande Avanzado e retorna o texto do body. */
  async function renderAndExpandWithSex(accAValue: string, accBValue: string): Promise<string> {
    const field: DedupFieldComparison = {
      field: 'sex_encrypted',
      values: { 'acc-A': accAValue, 'acc-B': accBValue },
      is_encrypted: true,
      has_conflict: true,
    };
    const { unmount } = renderComponent({ fieldComparisons: [field], accounts: ACCOUNTS });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });
    const text = document.body.textContent ?? '';
    unmount();
    return text;
  }

  it('sex_encrypted "mujer" resolves via i18n key (not shown verbatim)', async () => {
    const text = await renderAndExpandWithSex('mujer', 'MALE');
    // i18n key is rendered (no translations loaded in tests)
    expect(text).toContain('workerRegistration.generalInfo.female');
    expect(text).not.toContain('mujer');
  });

  it('sex_encrypted "Hombre" resolves via i18n key (not shown verbatim)', async () => {
    const text = await renderAndExpandWithSex('FEMALE', 'Hombre');
    expect(text).toContain('workerRegistration.generalInfo.male');
    expect(text).not.toContain('Hombre');
  });

  it('sex_encrypted "Femenino" resolves via i18n key (not shown verbatim)', async () => {
    const text = await renderAndExpandWithSex('Femenino', 'male');
    expect(text).toContain('workerRegistration.generalInfo.female');
    expect(text).not.toContain('Femenino');
  });

  it('sex_encrypted "Masculino" resolves via i18n key (not shown verbatim)', async () => {
    const text = await renderAndExpandWithSex('female', 'Masculino');
    expect(text).toContain('workerRegistration.generalInfo.male');
    expect(text).not.toContain('Masculino');
  });

  it('sex_encrypted "Varón" resolves via i18n key (not shown verbatim)', async () => {
    const text = await renderAndExpandWithSex('female', 'Varón');
    expect(text).toContain('workerRegistration.generalInfo.male');
    expect(text).not.toContain('Varón');
  });

  it('gender_encrypted "Femenino" also resolves via i18n (same SSOT)', async () => {
    const field: DedupFieldComparison = {
      field: 'gender_encrypted',
      values: { 'acc-A': 'Femenino', 'acc-B': 'male' },
      is_encrypted: true,
      has_conflict: true,
    };
    renderComponent({ fieldComparisons: [field], accounts: ACCOUNTS });
    const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(toggle); });
    expect(document.body.textContent).toContain('workerRegistration.generalInfo.female');
    expect(document.body.textContent).not.toContain('Femenino');
  });
});
