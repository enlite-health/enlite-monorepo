import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DraggableCard } from '../DraggableCard';

// Track what useDraggable returns so we can simulate drag states
const mockUseDraggable = vi.fn();

vi.mock('@dnd-kit/core', () => ({
  useDraggable: (args: unknown) => mockUseDraggable(args),
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

describe('DraggableCard', () => {
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
});
