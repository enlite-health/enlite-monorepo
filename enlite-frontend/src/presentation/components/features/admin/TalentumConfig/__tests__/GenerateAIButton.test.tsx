import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GenerateAIButton } from '../GenerateAIButton';
import type { GenerateAIButtonStatus } from '../GenerateAIButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'es' },
  }),
}));

function renderBtn(
  status: GenerateAIButtonStatus,
  hasExistingContent: boolean,
  onClick = vi.fn(),
  errorMessage?: string,
) {
  return render(
    <GenerateAIButton
      status={status}
      hasExistingContent={hasExistingContent}
      onClick={onClick}
      errorMessage={errorMessage}
    />,
  );
}

describe('GenerateAIButton', () => {
  it('renders primary button in idle state (no content)', () => {
    renderBtn('idle', false);
    const btn = screen.getByRole('button');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn.className).toContain('bg-[#180149]');
  });

  it('renders disabled button in loading state', () => {
    renderBtn('loading', false);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
  });

  it('renders outline variant when content already exists', () => {
    renderBtn('success', true);
    const btn = screen.getByRole('button');
    expect(btn).not.toBeDisabled();
    expect(btn.className).toContain('border-[#180149]');
    expect(btn.className).toContain('bg-transparent');
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    renderBtn('idle', false, onClick);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does NOT call onClick when disabled (loading)', () => {
    const onClick = vi.fn();
    renderBtn('loading', false, onClick);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows error message when status is error (primary variant)', () => {
    renderBtn('error', false, vi.fn(), 'Algo falló');
    expect(screen.getByText('Algo falló')).toBeInTheDocument();
  });

  it('shows error message in outline (regenerate) variant', () => {
    renderBtn('error', true, vi.fn(), 'Error al regenerar');
    expect(screen.getByText('Error al regenerar')).toBeInTheDocument();
  });
});
