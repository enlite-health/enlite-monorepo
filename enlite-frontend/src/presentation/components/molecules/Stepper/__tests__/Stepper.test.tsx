import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stepper } from '../Stepper';

const STEPS = [
  { label: 'First' },
  { label: 'Second' },
  { label: 'Third' },
];

describe('Stepper', () => {
  it('renders all step labels', () => {
    render(<Stepper steps={STEPS} currentStep={1} />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
  });

  it('renders step numbers when not completed', () => {
    render(<Stepper steps={STEPS} currentStep={1} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('marks the current step with aria-current=step', () => {
    render(<Stepper steps={STEPS} currentStep={2} />);
    const currentLi = screen.getByText('Second').closest('li');
    expect(currentLi).toHaveAttribute('aria-current', 'step');
  });

  it('replaces number with check icon for completed steps', () => {
    render(<Stepper steps={STEPS} currentStep={3} />);
    // First and Second are completed → number 1 and 2 are no longer in the DOM
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('Stepper — aria-label vem da tradução (common.progress)', () => {
  it('usa a chave, não um literal fixo', async () => {
    const { default: i18n } = await import('i18next');
    i18n.addResourceBundle('pt-BR', 'translation', { common: { progress: '(SENTINELA)' } }, true, true);
    try {
      render(<Stepper steps={STEPS} currentStep={1} />);
      expect(screen.getByRole('list', { name: '(SENTINELA)' })).toBeInTheDocument();
    } finally {
      i18n.removeResourceBundle('pt-BR', 'translation');
    }
  });
});
