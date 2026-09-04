/**
 * IcdSearchCombobox — busca CID-11 (spec 016 F3). Estados VISÍVEIS e distintos (US-4):
 * digitando · buscando · sem resultado · catálogo indisponível. Cancelamento de busca obsoleta
 * (a resposta antiga não pode sobrescrever a nova). Teclado + a11y.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { IcdSearchCombobox } from '../IcdSearchCombobox';
import { TerminologyUnavailableError } from '@infrastructure/http/AdminTerminologyApiService';

const translations = ptBR as Record<string, any>;
function t(key: string, optsOrDefault?: any): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  if (typeof current === 'string') {
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const search = vi.fn();
vi.mock('@infrastructure/http/AdminTerminologyApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminTerminologyApiService')>();
  return {
    TerminologyUnavailableError: actual.TerminologyUnavailableError,
    AdminTerminologyApiService: { search: (...a: unknown[]) => search(...a) },
  };
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('IcdSearchCombobox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders o input como combobox, com placeholder i18n e fechado', () => {
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    const input = screen.getByTestId('icd-search-input');
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('placeholder', 'Buscar diagnóstico em espanhol...');
    expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icd-search-status')).not.toBeInTheDocument();
  });

  it('campo vazio: fase idle, sem status e sem busca disparada', () => {
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: '' } });
    vi.advanceTimersByTime(1000);
    expect(screen.queryByTestId('icd-search-status')).not.toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it('U5: com 1 caractere NÃO fica em silêncio — mostra a dica do mínimo de 2 caracteres', () => {
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'e' } });
    vi.advanceTimersByTime(1000);
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Digite pelo menos 2 caracteres.');
    expect(search).not.toHaveBeenCalled();
  });

  it('U5: com 2 caracteres a dica some e a busca é disparada normalmente', async () => {
    search.mockReturnValue(new Promise(() => {}));
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'es' } });
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Digitando…');
    await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('digitando (antes do debounce): mostra "Digitando…" — estado distinto de "Buscando…"', () => {
    search.mockReturnValue(new Promise(() => {}));
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquiso' } });
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Digitando…');
    expect(search).not.toHaveBeenCalled();
  });

  it('após o debounce: dispara a busca com o filtro padrão de capítulos 06,08 e mostra "Buscando…"', async () => {
    search.mockReturnValue(new Promise(() => {}));
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquisofrenia' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toBe('esquisofrenia');
    expect(search.mock.calls[0][1]).toMatchObject({ chapters: '06,08' });
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Buscando…');
  });

  it('resultados: abre o listbox com role=option e mostra só o título (nunca URI/código)', async () => {
    search.mockResolvedValue([
      { uri: 'http://id.who.int/icd/release/11/2026-01/mms/1683919430', title: 'Esquizofrenia' },
    ]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquisofrenia' } });
    await vi.advanceTimersByTimeAsync(300);
    const listbox = screen.getByTestId('icd-search-listbox');
    expect(listbox).toHaveAttribute('role', 'listbox');
    const option = screen.getByTestId('icd-search-option-0');
    expect(option).toHaveAttribute('role', 'option');
    expect(option.textContent).toBe('Esquizofrenia');
    expect(listbox.innerHTML).not.toContain('1683919430');
    expect(listbox.innerHTML).not.toContain('6A20');
  });

  it('V1: o controle de escopo aparece ANTES de qualquer digitação, com "categorias habituais" selecionado por padrão', () => {
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    const usual = screen.getByTestId('icd-search-scope-usual');
    const all = screen.getByTestId('icd-search-scope-all');
    expect(usual).toBeInTheDocument();
    expect(all).toBeInTheDocument();
    expect(usual).toHaveAttribute('aria-checked', 'true');
    expect(all).toHaveAttribute('aria-checked', 'false');
    expect(search).not.toHaveBeenCalled();
  });

  it('V1: o rótulo do controle não usa a palavra "capítulo" nem números — só o texto do que ele descreve', () => {
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    const usualText = screen.getByTestId('icd-search-scope-usual').textContent ?? '';
    const allText = screen.getByTestId('icd-search-scope-all').textContent ?? '';
    expect(usualText.toLowerCase()).not.toContain('capítulo');
    expect(usualText).not.toMatch(/\d/);
    expect(allText.toLowerCase()).not.toContain('capítulo');
    expect(allText).not.toMatch(/\d/);
  });

  it('V1: alternar para "todas las categorías" muda o filtro enviado (chapters undefined) e a escolha fica marcada', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('icd-search-scope-all'));
    expect(screen.getByTestId('icd-search-scope-all')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('icd-search-scope-usual')).toHaveAttribute('aria-checked', 'false');
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'diabetes' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][1]).toMatchObject({ chapters: undefined });
  });

  it('V1: a escolha "todas las categorías" PERSISTE entre buscas diferentes, sem voltar ao padrão a cada tecla', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('icd-search-scope-all'));
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'diabetes' } });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'autismo' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-scope-all')).toHaveAttribute('aria-checked', 'true');
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][1]).toMatchObject({ chapters: undefined });
  });

  it('V1: voltar para "categorias habituais" restaura o filtro padrão (06,08)', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('icd-search-scope-all'));
    fireEvent.click(screen.getByTestId('icd-search-scope-usual'));
    expect(screen.getByTestId('icd-search-scope-usual')).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'diabetes' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(search.mock.calls[0][1]).toMatchObject({ chapters: '06,08' });
  });

  it('V1: nenhuma 2ª requisição é disparada mais — uma busca com resultado dispara UMA chamada só', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Diabetes mellitus tipo 1' }]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'diabetes' } });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300); // tempo de sobra pra qualquer 2ª chamada que tivesse sido disparada
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('V1: o aviso antigo "resultados en otras categorías" não existe mais em lugar nenhum da tela', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Diabetes mellitus tipo 1' }]);
    const { container } = render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'diabetes' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.queryByTestId('icd-search-outside-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icd-search-toggle-chapters')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/otras categorías/i);
  });

  it('U5: reduzir de uma busca ativa para 1 caractere aborta a busca em andamento', async () => {
    search.mockReturnValue(new Promise(() => {}));
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    const input = screen.getByTestId('icd-search-input');
    fireEvent.change(input, { target: { value: 'es' } });
    await vi.advanceTimersByTimeAsync(300); // dispara a busca — seta abortRef.current
    fireEvent.change(input, { target: { value: 'e' } }); // volta abaixo do mínimo
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Digite pelo menos 2 caracteres.');
  });

  it('sem resultado: mostra mensagem "No results" — SEM listbox', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'zzzxyz' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Nenhum resultado encontrado para "zzzxyz".');
    expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
  });

  it('U6: buscar por CÓDIGO (letra+dígitos) sem resultado ganha a dica de que a busca é por NOME', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'F84' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-code-hint')).toHaveTextContent(
      'A busca é pelo NOME do diagnóstico, não pelo código nem pela sigla.',
    );
  });

  it('U6: buscar por SIGLA (maiúsculas 2-5 letras) sem resultado também ganha a dica', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'TDAH' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-code-hint')).toBeInTheDocument();
  });

  it('U6: termo genérico sem resultado NÃO ganha a dica de código/sigla', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'xxxxx' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Nenhum resultado');
    expect(screen.queryByTestId('icd-search-code-hint')).not.toBeInTheDocument();
  });

  it('US-4: catálogo indisponível (503) mostra mensagem DIFERENTE de "sem resultado", com role=alert', async () => {
    search.mockRejectedValue(new TerminologyUnavailableError());
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquisofrenia' } });
    await vi.advanceTimersByTimeAsync(300);
    const status = screen.getByTestId('icd-search-status');
    expect(status).toHaveTextContent('Não foi possível conectar ao catálogo de diagnósticos. Tente novamente em alguns minutos.');
    expect(status).not.toHaveTextContent('Nenhum resultado');
    expect(status).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
  });

  it('erro genérico (não TerminologyUnavailableError) cai no estado "sem resultado", nunca crasha', async () => {
    search.mockRejectedValue(new Error('boom'));
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquisofrenia' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-status')).toHaveTextContent('Nenhum resultado');
  });

  it('resposta obsoleta NUNCA sobrescreve a mais nova (requestId descarta a antiga)', async () => {
    const first = deferred<{ uri: string; title: string }[]>();
    const second = deferred<{ uri: string; title: string }[]>();
    search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    const input = screen.getByTestId('icd-search-input');

    fireEvent.change(input, { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300); // dispara a 1ª busca
    fireEvent.change(input, { target: { value: 'esquisofrenia' } });
    await vi.advanceTimersByTimeAsync(300); // dispara a 2ª busca

    expect(search).toHaveBeenCalledTimes(2);

    // resolve a NOVA primeiro, depois a VELHA chega atrasada
    await act(async () => { second.resolve([{ uri: 'u-novo', title: 'Resultado novo' }]); });
    expect(screen.getByTestId('icd-search-option-0').textContent).toBe('Resultado novo');

    await act(async () => { first.resolve([{ uri: 'u-velho', title: 'Resultado velho (obsoleto)' }]); });
    // a tela continua mostrando o resultado NOVO — a resposta velha foi descartada
    expect(screen.getByTestId('icd-search-option-0').textContent).toBe('Resultado novo');
    expect(screen.queryByText('Resultado velho (obsoleto)')).not.toBeInTheDocument();
  });

  it('rejeição obsoleta (a busca velha FALHA depois da nova já ter respondido) também é descartada', async () => {
    const first = deferred<{ uri: string; title: string }[]>();
    const second = deferred<{ uri: string; title: string }[]>();
    search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    first.promise.catch(() => {}); // evita unhandledRejection no Node ao rejeitar mais tarde

    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    const input = screen.getByTestId('icd-search-input');
    fireEvent.change(input, { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.change(input, { target: { value: 'esquisofrenia' } });
    await vi.advanceTimersByTimeAsync(300);

    await act(async () => { second.resolve([{ uri: 'u-novo', title: 'Resultado novo' }]); });
    expect(screen.getByTestId('icd-search-option-0').textContent).toBe('Resultado novo');

    // a busca VELHA rejeita depois — obsoleta, não pode virar "catálogo indisponível" na tela
    await act(async () => { first.reject(new Error('rede caiu na busca velha')); });
    expect(screen.getByTestId('icd-search-option-0').textContent).toBe('Resultado novo');
    expect(screen.queryByTestId('icd-search-status')).not.toBeInTheDocument();
  });

  it('teclado: ArrowDown/ArrowUp navegam, Enter escolhe o destacado, Esc fecha', async () => {
    search.mockResolvedValue([
      { uri: 'u1', title: 'Esquizofrenia' },
      { uri: 'u2', title: 'Trastorno esquizoafectivo' },
    ]);
    const onSelect = vi.fn();
    render(<IcdSearchCombobox id="icd-search" onSelect={onSelect} />);
    const input = screen.getByTestId('icd-search-input');
    fireEvent.change(input, { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('icd-search-option-0')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('icd-search-option-1')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // não passa do último
    expect(screen.getByTestId('icd-search-option-1')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('icd-search-option-0')).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', 'icd-search-option-0');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith({ uri: 'u1', title: 'Esquizofrenia' });
    expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('Esc fecha o dropdown sem selecionar nada', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Esquizofrenia' }]);
    const onSelect = vi.fn();
    render(<IcdSearchCombobox id="icd-search" onSelect={onSelect} />);
    const input = screen.getByTestId('icd-search-input');
    fireEvent.change(input, { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-listbox')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('U2: com a LISTA ABERTA, Esc não vaza pro document — o drawer (listener lá fora) não fecha', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Esquizofrenia' }]);
    const outerDrawerListener = vi.fn();
    document.addEventListener('keydown', outerDrawerListener);
    try {
      render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
      const input = screen.getByTestId('icd-search-input');
      fireEvent.change(input, { target: { value: 'esquiso' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(screen.getByTestId('icd-search-listbox')).toBeInTheDocument();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
      expect(outerDrawerListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outerDrawerListener);
    }
  });

  it('U2: com a LISTA FECHADA, Esc propaga normalmente (o drawer segue seu comportamento padrão)', () => {
    const outerDrawerListener = vi.fn();
    document.addEventListener('keydown', outerDrawerListener);
    try {
      render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
      const input = screen.getByTestId('icd-search-input');
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(outerDrawerListener).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', outerDrawerListener);
    }
  });

  it('Enter sem item destacado (activeIndex=-1) não seleciona nada', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Esquizofrenia' }]);
    const onSelect = vi.fn();
    render(<IcdSearchCombobox id="icd-search" onSelect={onSelect} />);
    const input = screen.getByTestId('icd-search-input');
    fireEvent.change(input, { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('teclado é ignorado quando o dropdown está fechado (guarda !isOpen)', () => {
    const onSelect = vi.fn();
    render(<IcdSearchCombobox id="icd-search" onSelect={onSelect} />);
    const input = screen.getByTestId('icd-search-input');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clique numa opção também seleciona (mouse, não só teclado)', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Esquizofrenia' }]);
    const onSelect = vi.fn();
    render(<IcdSearchCombobox id="icd-search" onSelect={onSelect} />);
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.mouseEnter(screen.getByTestId('icd-search-option-0'));
    fireEvent.click(screen.getByTestId('icd-search-option-0'));
    expect(onSelect).toHaveBeenCalledWith({ uri: 'u1', title: 'Esquizofrenia' });
  });

  it('clique fora fecha o dropdown', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Esquizofrenia' }]);
    render(
      <div>
        <IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />
        <button data-testid="outside">fora</button>
      </div>,
    );
    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-listbox')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
  });

  it('V1: clicar em "todas las categorías" marca o controle e envia chapters=undefined na próxima busca', async () => {
    search.mockResolvedValue([]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('icd-search-scope-all'));

    fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(search.mock.calls[0][1]).toEqual({ chapters: undefined, signal: expect.anything() });
  });

  it('disabled: o input fica desabilitado', () => {
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} disabled />);
    expect(screen.getByTestId('icd-search-input')).toBeDisabled();
  });

  it('apagar o texto abaixo do mínimo fecha o dropdown e volta pro idle', async () => {
    search.mockResolvedValue([{ uri: 'u1', title: 'Esquizofrenia' }]);
    render(<IcdSearchCombobox id="icd-search" onSelect={vi.fn()} />);
    const input = screen.getByTestId('icd-search-input');
    fireEvent.change(input, { target: { value: 'esquiso' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByTestId('icd-search-listbox')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByTestId('icd-search-listbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icd-search-status')).not.toBeInTheDocument();
  });
});
