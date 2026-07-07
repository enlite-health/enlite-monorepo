import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DraggableCard } from '../DraggableCard';

// Track what useDraggable receives so we can assert disabled propagation
const mockUseDraggable = vi.fn();

vi.mock('@dnd-kit/core', () => ({
  useDraggable: (args: unknown) => mockUseDraggable(args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function setupDraggable(overrides: Record<string, unknown> = {}) {
  mockUseDraggable.mockReturnValue({
    attributes: { role: 'button', tabIndex: 0 },
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
    ...overrides,
  });
}

describe('DraggableCard — enabled (default)', () => {
  it('does not apply inline transform style when dragging (DragOverlay handles it)', () => {
    // Simulate active drag — dnd-kit provides a non-null transform
    setupDraggable({
      isDragging: true,
      transform: { x: 150, y: 80, scaleX: 1, scaleY: 1 },
    });

    render(<DraggableCard id="enc-1"><span>Card</span></DraggableCard>);

    const card = screen.getByTestId('kanban-draggable-enc-1');
    expect(card.style.transform).toBe('');
  });

  it('applies opacity-30 class when dragging', () => {
    setupDraggable({ isDragging: true });

    render(<DraggableCard id="enc-1"><span>Card</span></DraggableCard>);

    const card = screen.getByTestId('kanban-draggable-enc-1');
    expect(card.className).toContain('opacity-30');
  });

  it('does not apply opacity-30 when not dragging', () => {
    setupDraggable({ isDragging: false });

    render(<DraggableCard id="enc-1"><span>Card</span></DraggableCard>);

    const card = screen.getByTestId('kanban-draggable-enc-1');
    expect(card.className).not.toContain('opacity-30');
  });

  it('renders children inside the draggable wrapper', () => {
    setupDraggable();

    render(<DraggableCard id="enc-1"><span>My Card Content</span></DraggableCard>);

    expect(screen.getByText('My Card Content')).toBeInTheDocument();
  });

  it('passes disabled=false to useDraggable by default', () => {
    setupDraggable();

    render(<DraggableCard id="enc-2"><span>Card</span></DraggableCard>);

    expect(mockUseDraggable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'enc-2', disabled: false }),
    );
  });
});

describe('DraggableCard — disabled (orphan card)', () => {
  it('passes disabled=true to useDraggable when disabled prop is true', () => {
    setupDraggable();

    render(<DraggableCard id="orphan-1" disabled><span>Card</span></DraggableCard>);

    expect(mockUseDraggable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'orphan-1', disabled: true }),
    );
  });

  it('sets data-drag-disabled="true" on the wrapper', () => {
    setupDraggable();

    render(<DraggableCard id="orphan-1" disabled><span>Card</span></DraggableCard>);

    const wrapper = screen.getByTestId('kanban-draggable-orphan-1');
    expect(wrapper.getAttribute('data-drag-disabled')).toBe('true');
  });

  it('applies cursor-not-allowed class on the wrapper when disabled', () => {
    setupDraggable();

    render(<DraggableCard id="orphan-1" disabled><span>Card</span></DraggableCard>);

    const wrapper = screen.getByTestId('kanban-draggable-orphan-1');
    expect(wrapper.className).toContain('cursor-not-allowed');
  });

  it('shows tooltip title with i18n key when disabled', () => {
    setupDraggable();

    render(<DraggableCard id="orphan-1" disabled><span>Card</span></DraggableCard>);

    const wrapper = screen.getByTestId('kanban-draggable-orphan-1');
    expect(wrapper.getAttribute('title')).toBe('admin.kanban.orphanDragTooltip');
  });

  it('renders children inside a dimmed (opacity-70) wrapper when disabled', () => {
    setupDraggable();

    render(<DraggableCard id="orphan-1" disabled><span>Orphan Content</span></DraggableCard>);

    expect(screen.getByText('Orphan Content')).toBeInTheDocument();
    const inner = screen.getByText('Orphan Content').parentElement;
    expect(inner?.className).toContain('opacity-70');
  });

  it('does NOT block pointer events on children when disabled — only DRAG is blocked, not clicks (e.g. profile link, notes button on BLOQUEADO cards)', () => {
    setupDraggable();

    render(<DraggableCard id="orphan-1" disabled><span>Orphan Content</span></DraggableCard>);

    const inner = screen.getByText('Orphan Content').parentElement;
    expect(inner?.className).not.toContain('pointer-events-none');
  });
});
