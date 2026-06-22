/**
 * DedupTabs.test.tsx
 *
 * Covers:
 * - queue, history (active), imported (disabled) tabs render correctly
 * - Clicking queue/history buttons calls onTabChange
 * - Clicking the disabled imported tab does NOT call onTabChange
 * - Active tab has bg-primary styling
 * - Inactive tab has tabInactive styling (no bg-primary)
 * - Disabled tab has cursor-not-allowed and aria-disabled="true"
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
  it('renders queue and history as clickable buttons', () => {
    renderTabs();
    const buttons = screen.getAllByRole('button');
    // queue and history are non-disabled; imported is disabled (<span>)
    expect(buttons).toHaveLength(2);
  });

  it('renders the imported tab as a span with aria-disabled="true"', () => {
    renderTabs();
    const span = document.querySelector('[aria-disabled="true"]');
    expect(span).not.toBeNull();
    expect(span?.getAttribute('aria-disabled')).toBe('true');
  });
});

// ── onClick fires for non-disabled tabs ──────────────────────────────────────

describe('DedupTabs — onClick fires for non-disabled tabs', () => {
  it('clicking the queue button calls onTabChange with "queue"', () => {
    const onTabChange = vi.fn();
    renderTabs('history', onTabChange);

    // queue is inactive (not active=history), find by text key
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

  it('onTabChange is called even when active tab is clicked again', () => {
    const onTabChange = vi.fn();
    renderTabs('queue', onTabChange);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]); // click queue while queue is active
    expect(onTabChange).toHaveBeenCalledWith('queue');
  });
});

// ── Disabled tab does NOT fire ────────────────────────────────────────────────

describe('DedupTabs — disabled tab does NOT call onTabChange', () => {
  it('clicking the imported span does NOT call onTabChange', () => {
    const onTabChange = vi.fn();
    renderTabs('queue', onTabChange);

    const disabledSpan = document.querySelector(
      '[aria-disabled="true"]',
    ) as HTMLElement;
    expect(disabledSpan).not.toBeNull();

    fireEvent.click(disabledSpan);
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

// ── Styling ───────────────────────────────────────────────────────────────────

describe('DedupTabs — styling', () => {
  it('active tab (queue) has bg-primary class', () => {
    renderTabs('queue');
    const buttons = screen.getAllByRole('button');
    expect(buttons[0].className).toContain('bg-primary'); // queue active
  });

  it('inactive tab does not have bg-primary class', () => {
    renderTabs('queue');
    const buttons = screen.getAllByRole('button');
    expect(buttons[1].className).not.toContain('bg-primary'); // history inactive
  });

  it('active history tab has bg-primary class', () => {
    renderTabs('history');
    const buttons = screen.getAllByRole('button');
    expect(buttons[1].className).toContain('bg-primary'); // history active
  });

  it('disabled tab has cursor-not-allowed class', () => {
    renderTabs('queue');
    const span = document.querySelector('[aria-disabled="true"]');
    expect(span?.className).toContain('cursor-not-allowed');
  });

  it('disabled tab has text-gray-400 class', () => {
    renderTabs('queue');
    const span = document.querySelector('[aria-disabled="true"]');
    expect(span?.className).toContain('text-gray-400');
  });
});
