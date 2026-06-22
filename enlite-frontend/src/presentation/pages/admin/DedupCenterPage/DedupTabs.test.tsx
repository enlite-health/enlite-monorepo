/**
 * DedupTabs.test.tsx
 *
 * Covers:
 * - queue, history, imported (all now active) tabs render correctly (Onda 4b)
 * - Clicking any of the three buttons calls onTabChange with correct tab id
 * - Active tab has bg-primary styling
 * - Inactive tabs do NOT have bg-primary
 * - No disabled spans exist (DISABLED_TABS is empty for Onda 4b)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DedupTabs, type DedupTab } from './DedupTabs';

// i18n in tests returns the key since no translations are loaded.

function renderTabs(
  activeTab: DedupTab = 'queue',
  onTabChange: (tab: DedupTab) => void = vi.fn(),
) {
  return render(<DedupTabs activeTab={activeTab} onTabChange={onTabChange} />);
}

// ── Renders ───────────────────────────────────────────────────────────────────

describe('DedupTabs — render', () => {
  it('renders all three tabs as clickable buttons (Onda 4b: imported is active)', () => {
    renderTabs();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
  });

  it('does NOT render any aria-disabled span (no disabled tabs in Onda 4b)', () => {
    renderTabs();
    const span = document.querySelector('[aria-disabled="true"]');
    expect(span).toBeNull();
  });
});

// ── onClick fires for all tabs ────────────────────────────────────────────────

describe('DedupTabs — onClick fires for all tabs', () => {
  it('clicking the queue button calls onTabChange with "queue"', () => {
    const onTabChange = vi.fn();
    renderTabs('history', onTabChange);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]); // first button = queue
    expect(onTabChange).toHaveBeenCalledWith('queue');
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  it('clicking the history button calls onTabChange with "history"', () => {
    const onTabChange = vi.fn();
    renderTabs('queue', onTabChange);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[1]); // second button = history
    expect(onTabChange).toHaveBeenCalledWith('history');
  });

  it('clicking the imported button calls onTabChange with "imported"', () => {
    const onTabChange = vi.fn();
    renderTabs('queue', onTabChange);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[2]); // third button = imported
    expect(onTabChange).toHaveBeenCalledWith('imported');
  });

  it('onTabChange is called even when active tab is clicked again', () => {
    const onTabChange = vi.fn();
    renderTabs('queue', onTabChange);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]); // click queue while queue is active
    expect(onTabChange).toHaveBeenCalledWith('queue');
  });
});

// ── Styling ───────────────────────────────────────────────────────────────────

describe('DedupTabs — styling', () => {
  it('active tab (queue) has bg-primary class', () => {
    renderTabs('queue');
    const buttons = screen.getAllByRole('button');
    expect(buttons[0].className).toContain('bg-primary'); // queue active
  });

  it('inactive tabs do not have bg-primary class', () => {
    renderTabs('queue');
    const buttons = screen.getAllByRole('button');
    expect(buttons[1].className).not.toContain('bg-primary'); // history inactive
    expect(buttons[2].className).not.toContain('bg-primary'); // imported inactive
  });

  it('active history tab has bg-primary class', () => {
    renderTabs('history');
    const buttons = screen.getAllByRole('button');
    expect(buttons[1].className).toContain('bg-primary'); // history active
  });

  it('active imported tab has bg-primary class', () => {
    renderTabs('imported');
    const buttons = screen.getAllByRole('button');
    expect(buttons[2].className).toContain('bg-primary'); // imported active
  });
});
