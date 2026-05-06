import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Typography } from './Typography';

// ── Existing variants ────────────────────────────────────────────────────────

describe('Typography — existing variants', () => {
  it('renders h1 as <h1>', () => {
    render(<Typography variant="h1">Heading</Typography>);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders h2 as <h2>', () => {
    render(<Typography variant="h2">Heading</Typography>);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('renders h3 as <h3>', () => {
    render(<Typography variant="h3">Heading</Typography>);
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
  });

  it('renders body as <p>', () => {
    render(<Typography variant="body">Body text</Typography>);
    expect(screen.getByText('Body text').tagName).toBe('P');
  });

  it('renders label as <p> by default', () => {
    render(<Typography variant="label">Label text</Typography>);
    expect(screen.getByText('Label text').tagName).toBe('P');
  });

  it('renders caption as <p> by default', () => {
    render(<Typography variant="caption">Caption</Typography>);
    expect(screen.getByText('Caption').tagName).toBe('P');
  });

  it('applies primary color class', () => {
    render(<Typography variant="body" color="primary">Text</Typography>);
    expect(screen.getByText('Text').className).toContain('text-primary');
  });

  it('applies semibold weight class', () => {
    render(<Typography variant="body" weight="semibold">Text</Typography>);
    expect(screen.getByText('Text').className).toContain('font-semibold');
  });

  it('respects as prop to override tag', () => {
    render(<Typography variant="body" as="span">Span text</Typography>);
    expect(screen.getByText('Span text').tagName).toBe('SPAN');
  });

  it('applies custom className', () => {
    render(<Typography variant="body" className="my-custom-class">Text</Typography>);
    expect(screen.getByText('Text').className).toContain('my-custom-class');
  });
});

// ── New variants ─────────────────────────────────────────────────────────────

describe('Typography — card-title variant', () => {
  it('renders as <p> by default', () => {
    render(<Typography variant="card-title">Card Title</Typography>);
    expect(screen.getByText('Card Title').tagName).toBe('P');
  });

  it('has font-lexend class', () => {
    render(<Typography variant="card-title">Card Title</Typography>);
    expect(screen.getByText('Card Title').className).toContain('font-lexend');
  });

  it('has text-[28px] class', () => {
    render(<Typography variant="card-title">Card Title</Typography>);
    expect(screen.getByText('Card Title').className).toContain('text-[28px]');
  });

  it('has leading-[1.3] class', () => {
    render(<Typography variant="card-title">Card Title</Typography>);
    expect(screen.getByText('Card Title').className).toContain('leading-[1.3]');
  });
});

describe('Typography — section-title variant', () => {
  it('renders as <p> by default', () => {
    render(<Typography variant="section-title">Section</Typography>);
    expect(screen.getByText('Section').tagName).toBe('P');
  });

  it('has text-[22px] class', () => {
    render(<Typography variant="section-title">Section</Typography>);
    expect(screen.getByText('Section').className).toContain('text-[22px]');
  });

  it('applies primary color', () => {
    render(<Typography variant="section-title" color="primary">Section</Typography>);
    expect(screen.getByText('Section').className).toContain('text-primary');
  });
});

describe('Typography — value variant', () => {
  it('renders as <p> by default', () => {
    render(<Typography variant="value">R$8.000,00</Typography>);
    expect(screen.getByText('R$8.000,00').tagName).toBe('P');
  });

  it('has text-[22px] class', () => {
    render(<Typography variant="value">R$8.000,00</Typography>);
    expect(screen.getByText('R$8.000,00').className).toContain('text-[22px]');
  });
});

describe('Typography — value-sm variant', () => {
  it('renders as <p> by default', () => {
    render(<Typography variant="value-sm">25/02/25</Typography>);
    expect(screen.getByText('25/02/25').tagName).toBe('P');
  });

  it('has text-[18px] class', () => {
    render(<Typography variant="value-sm">25/02/25</Typography>);
    expect(screen.getByText('25/02/25').className).toContain('text-[18px]');
  });
});

describe('Typography — day-name variant', () => {
  it('renders as <p> by default', () => {
    render(<Typography variant="day-name">Lunes:</Typography>);
    expect(screen.getByText('Lunes:').tagName).toBe('P');
  });

  it('has text-sm class', () => {
    render(<Typography variant="day-name">Lunes:</Typography>);
    expect(screen.getByText('Lunes:').className).toContain('text-sm');
  });

  it('has leading-[1.4] class', () => {
    render(<Typography variant="day-name">Lunes:</Typography>);
    expect(screen.getByText('Lunes:').className).toContain('leading-[1.4]');
  });
});
