import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AIDescriptionEditor } from '../AIDescriptionEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'es' },
  }),
}));

function renderEditor(value = '', onChange = vi.fn()) {
  return render(<AIDescriptionEditor value={value} onChange={onChange} />);
}

describe('AIDescriptionEditor', () => {
  it('renders textarea with current value', () => {
    renderEditor('Hello content');
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('Hello content');
  });

  it('shows character counter as 0/4000 when empty', () => {
    renderEditor('');
    expect(screen.getByText('0/4000')).toBeInTheDocument();
  });

  it('calls onChange when user types within limit', () => {
    const onChange = vi.fn();
    renderEditor('', onChange);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
  });

  it('shows correct count for existing value', () => {
    renderEditor('Hello');
    expect(screen.getByText('5/4000')).toBeInTheDocument();
  });

  it('does NOT call onChange when input would exceed 4000 chars', () => {
    const onChange = vi.fn();
    const longText = 'a'.repeat(4001);
    renderEditor('', onChange);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: longText } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('counter shows text-red-500 class at max characters', () => {
    const maxText = 'a'.repeat(4000);
    renderEditor(maxText);
    const counter = screen.getByText('4000/4000');
    expect(counter.className).toContain('text-red-500');
  });

  it('counter is NOT red below max', () => {
    renderEditor('some text');
    const counter = screen.getByText('9/4000');
    expect(counter.className).not.toContain('text-red-500');
  });
});

describe('AIDescriptionEditor — readOnly e default', () => {
  it('sem a prop (como o wizard usa): textarea editável e botão Guardar visível', () => {
    render(<AIDescriptionEditor value="x" onChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText('admin.talentumConfig.descriptionEditor.helper')).toBeInTheDocument();
    expect(screen.getByText('1/4000')).toBeInTheDocument();
  });

  it('readOnly: textarea não editável, sem botão Guardar, valor continua visível', () => {
    render(<AIDescriptionEditor value="x" onChange={vi.fn()} onSave={vi.fn()} readOnly />);
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox')).toHaveValue('x');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.talentumConfig.descriptionEditor.helper')).not.toBeInTheDocument();
    expect(screen.queryByText('1/4000')).not.toBeInTheDocument();
  });
});

