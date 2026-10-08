import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CopyToClipboardButton } from '../CopyToClipboardButton';

const URL_TEXTO = 'https://exemplo.test/x?a=1&b=2';

function setClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('CopyToClipboardButton', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('copia EXATAMENTE o texto, troca para Check por 2 s e volta; o rótulo acompanha', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<CopyToClipboardButton text={URL_TEXTO} label="Copiar" copiedLabel="Copiado" data-testid="cp" />);
    expect(screen.getByLabelText('Copiar')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(URL_TEXTO);
    expect(screen.getByTestId('copy-done-icon')).toBeInTheDocument();
    expect(screen.getByLabelText('Copiado')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1999); });
    expect(screen.getByTestId('copy-done-icon')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Copiar')).toBeInTheDocument();
  });

  it('segundo clique dentro dos 2 s reinicia o relógio (não volta cedo)', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyToClipboardButton text="x" label="Copiar" copiedLabel="Copiado" data-testid="cp" />);
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    act(() => { vi.advanceTimersByTime(1500); });
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByTestId('copy-done-icon')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument();
  });

  it('clipboard recusa (permissão/contexto inseguro): não lança, não mostra Check', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    render(<CopyToClipboardButton text="x" label="Copiar" copiedLabel="Copiado" data-testid="cp" />);
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    expect(screen.queryByTestId('copy-done-icon')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Copiar')).toBeInTheDocument();
  });

  it('o clique NÃO borbulha para a linha clicável em volta', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const onRow = vi.fn();
    render(<div onClick={onRow}><CopyToClipboardButton text="x" label="Copiar" copiedLabel="Copiado" data-testid="cp" /></div>);
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    expect(onRow).not.toHaveBeenCalled();
  });

  it('desmontar com o timer pendente não deixa timer solto', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const { unmount } = render(<CopyToClipboardButton text="x" label="Copiar" copiedLabel="Copiado" data-testid="cp" />);
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
