import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MultiSelect } from './MultiSelect';

describe('MultiSelect (molecule) — seta decorativa', () => {
  it('a imagem da seta é decorativa: alt vazio e aria-hidden (o texto ao lado já diz o que é)', () => {
    const { container } = render(
      <MultiSelect options={[{ value: 'a', label: 'A' }]} value={[]} onChange={() => {}} placeholder="Escolha" />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });
});
