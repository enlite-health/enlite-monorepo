import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Switch } from '../Switch';

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return <Switch checked={on} onChange={setOn} label="Rótulo de teste" disabled={disabled} />;
}

describe('Switch', () => {
  it('expõe role=switch com nome acessível do label e aria-checked inicial false', () => {
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Rótulo de teste' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('clique alterna e aria-checked acompanha', async () => {
    render(<Harness />);
    const sw = screen.getByRole('switch');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveClass('bg-primary');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveClass('bg-gray-600');
  });

  it('Space e Enter alternam pelo teclado', async () => {
    render(<Harness />);
    const sw = screen.getByRole('switch');
    sw.focus();
    await userEvent.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{Enter}');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('clicar no texto do label também alterna', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('Rótulo de teste'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('disabled não alterna', async () => {
    render(<Harness disabled />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeDisabled();
    await userEvent.click(sw);
    await userEvent.click(screen.getByText('Rótulo de teste'));
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});
