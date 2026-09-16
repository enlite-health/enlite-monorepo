import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OriginLegend } from './OriginLegend';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('OriginLegend', () => {
  it('POSITIVO — fechada por padrão, sem popover no DOM', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    expect(screen.queryByTestId('legend-popover')).not.toBeInTheDocument();
  });

  it('POSITIVO — clique no ⓘ abre o popover com as 3 origens', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    fireEvent.click(screen.getByTestId('legend-trigger'));
    expect(screen.getByTestId('legend-popover')).toBeInTheDocument();
    expect(screen.getByTestId('legend-item-app')).toBeInTheDocument();
    expect(screen.getByTestId('legend-item-web_admin')).toBeInTheDocument();
    expect(screen.getByTestId('legend-item-sin_checkin')).toBeInTheDocument();
  });

  it('POSITIVO — clique de novo no ⓘ fecha o popover', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    const trigger = screen.getByTestId('legend-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('legend-popover')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('legend-popover')).not.toBeInTheDocument();
  });

  it('POSITIVO — botão de fechar (×) fecha o popover', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    fireEvent.click(screen.getByTestId('legend-trigger'));
    fireEvent.click(screen.getByTestId('legend-close'));
    expect(screen.queryByTestId('legend-popover')).not.toBeInTheDocument();
  });

  it('POSITIVO — Esc fecha o popover', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    fireEvent.click(screen.getByTestId('legend-trigger'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('legend-popover')).not.toBeInTheDocument();
  });

  it('POSITIVO — clique fora fecha o popover', () => {
    render(
      <div>
        <div data-testid="outside">fora</div>
        <OriginLegend testIdPrefix="legend" />
      </div>,
    );
    fireEvent.click(screen.getByTestId('legend-trigger'));
    expect(screen.getByTestId('legend-popover')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('legend-popover')).not.toBeInTheDocument();
  });

  it('POSITIVO — clique DENTRO do popover não fecha', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    fireEvent.click(screen.getByTestId('legend-trigger'));
    fireEvent.mouseDown(screen.getByTestId('legend-popover'));
    expect(screen.getByTestId('legend-popover')).toBeInTheDocument();
  });

  it('POSITIVO — scroll e resize com popover aberto não quebram (reposiciona)', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    fireEvent.click(screen.getByTestId('legend-trigger'));
    fireEvent.scroll(window);
    fireEvent(window, new Event('resize'));
    expect(screen.getByTestId('legend-popover')).toBeInTheDocument();
  });

  it('POSITIVO — mousedown DENTRO do próprio ⓘ (trigger) não fecha o popover já aberto', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    const trigger = screen.getByTestId('legend-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('legend-popover')).toBeInTheDocument();
    fireEvent.mouseDown(trigger);
    expect(screen.getByTestId('legend-popover')).toBeInTheDocument();
  });

  it('POSITIVO — sem espaço abaixo mas com espaço acima, o popover abre PARA CIMA (openUp)', () => {
    render(<OriginLegend testIdPrefix="legend" />);
    const trigger = screen.getByTestId('legend-trigger');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 720, left: 100, right: 120, width: 20, height: 20, x: 100, y: 700, toJSON: () => ({}) } as DOMRect);
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    fireEvent.click(trigger);
    const popover = screen.getByTestId('legend-popover');
    Object.defineProperty(popover, 'offsetHeight', { value: 300, configurable: true });
    Object.defineProperty(popover, 'offsetWidth', { value: 288, configurable: true });
    // Dispara o recálculo de posição com as medidas forçadas (scroll re-executa updatePosition).
    fireEvent.scroll(window);
    // spaceBelow = 768-720 = 48 < 300+8 (não cabe embaixo); top(700) >= 300+8 (cabe em cima) => openUp.
    expect(popover.style.top).toBe(`${700 - 300 - 8}px`);
  });
});
