/**
 * useInView (096 DD-8): o mapa só monta quando a seção entra na viewport — inclusive quando o nó aparece DEPOIS do 1º render
 * (a seção sai do esqueleto quando a rota responde; bug medido no e2e: o observador nunca pegava o nó).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useState } from 'react';
import { useInView } from './useInView';

let trigger: (isIntersecting: boolean) => void = () => undefined;
const observed: Element[] = [];

class FakeObserver {
  constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {
    trigger = (v) => this.cb([{ isIntersecting: v }]);
  }
  observe(el: Element) { observed.push(el); }
  disconnect() { /* noop */ }
}

function Probe({ lateMount }: { lateMount: boolean }): JSX.Element {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [, force] = useState(0);
  void force;
  return (
    <div>
      {lateMount && <div ref={ref} data-testid="box" />}
      <span data-testid="state">{String(inView)}</span>
    </div>
  );
}

afterEach(() => { vi.unstubAllGlobals(); observed.length = 0; });

describe('useInView', () => {
  it('sem IntersectionObserver vale true (o mapa nunca fica sem carregar)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Probe lateMount />);
    expect(screen.getByTestId('state')).toHaveTextContent('true');
  });

  it('com observador: começa false e vira true ao intersectar', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    render(<Probe lateMount />);
    expect(screen.getByTestId('state')).toHaveTextContent('false');
    expect(observed).toHaveLength(1);
    act(() => trigger(false));
    expect(screen.getByTestId('state')).toHaveTextContent('false');
    act(() => trigger(true));
    expect(screen.getByTestId('state')).toHaveTextContent('true');
  });

  it('nó que monta DEPOIS do primeiro render também é observado', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { rerender } = render(<Probe lateMount={false} />);
    expect(observed).toHaveLength(0);
    rerender(<Probe lateMount />);
    expect(observed).toHaveLength(1);
  });
});
