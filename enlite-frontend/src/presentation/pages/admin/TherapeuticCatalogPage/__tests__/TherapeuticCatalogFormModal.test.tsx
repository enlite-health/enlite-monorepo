/**
 * TherapeuticCatalogFormModal — criar/renomear uma opção de catálogo do projeto terapêutico
 * (spec 017, D299).
 *
 * i18n resolvido contra o pt-BR.json REAL (chave errada aparece como a própria chave e o teste
 * quebra). Nenhum mock além de i18n e do `onSave`/`onClose` que o pai injeta — a fronteira desta
 * peça é justamente esse par de callbacks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../test/rawEnumLeakGuard';
import type { TherapeuticCatalogItem } from '@domain/entities/TherapeuticProject';

const translations = ptBR as Record<string, any>;

function t(key: string, opts?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current !== 'string') return typeof opts === 'string' ? opts : key;
  return current.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => String(opts?.[k] ?? ''));
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const { TherapeuticCatalogFormModal, catalogRefusalMessage } = await import('../TherapeuticCatalogFormModal');

const COPY = ptBR.admin.therapeuticCatalog;

function item(over: Partial<TherapeuticCatalogItem> = {}): TherapeuticCatalogItem {
  return {
    id: 'i1',
    label: 'Mejorar autonomía',
    sortOrder: 7,
    active: true,
    deactivatedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  };
}

const onSave = vi.fn();
const onClose = vi.fn();

/** Renderiza e espera o `requestAnimationFrame` do slide-in (o painel entra em `show`). */
async function renderModal(alvo: TherapeuticCatalogItem | null = null) {
  const utils = render(<TherapeuticCatalogFormModal item={alvo} onSave={onSave} onClose={onClose} />);
  await waitFor(() => expect(utils.container.querySelector('form')).toHaveClass('translate-x-0'));
  return utils;
}

const textoInput = () => screen.getByTestId('therapeutic-catalog-label-input');
const ordemInput = () => screen.getByTestId('therapeutic-catalog-order-input');
const salvar = () => screen.getByTestId('therapeutic-catalog-form-save');

describe('TherapeuticCatalogFormModal — criar × editar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  it('criar: título "Nova opção", campos vazios e o botão de salvar nasce desabilitado', async () => {
    const { container } = await renderModal(null);

    expect(screen.getByRole('heading')).toHaveTextContent(COPY.newItem);
    expect(textoInput()).toHaveValue('');
    expect(ordemInput()).toHaveValue(null);
    expect(salvar()).toBeDisabled();
    expect(salvar()).toHaveTextContent(COPY.form.save);
    expectNoRawEnumLeaks(container);
  });

  it('editar: título "Editar opção" e os valores da opção já no formulário', async () => {
    await renderModal(item({ label: 'Rutina de higiene', sortOrder: 3 }));

    expect(screen.getByRole('heading')).toHaveTextContent(COPY.editItem);
    expect(textoInput()).toHaveValue('Rutina de higiene');
    expect(ordemInput()).toHaveValue(3);
    expect(salvar()).not.toBeDisabled();
  });

  it('a ajuda do campo diz o que o servidor cobra: espanhol, e SEM dado de pessoa (lex C18)', async () => {
    await renderModal(null);
    expect(screen.getByText(COPY.form.labelHelp)).toBeInTheDocument();
    expect(screen.getByText(COPY.form.sortOrderHelp)).toBeInTheDocument();
  });

  it('o `requestAnimationFrame` do slide-in é cancelado ao desmontar (nada roda depois)', async () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<TherapeuticCatalogFormModal item={null} onSave={onSave} onClose={onClose} />);
    // Antes do frame: o painel está fora da tela e o fundo transparente.
    expect(document.querySelector('form')).toHaveClass('translate-x-full');
    unmount();
    expect(cancel).toHaveBeenCalled();
    cancel.mockRestore();
  });
});

describe('TherapeuticCatalogFormModal — contador e teto de 200 caracteres', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  it('o contador conta o texto SEM espaços das pontas — é isso que vai ao servidor', async () => {
    await renderModal(null);
    expect(screen.getByTestId('therapeutic-catalog-label-count')).toHaveTextContent('0/200');

    fireEvent.change(textoInput(), { target: { value: '   Aseo   ' } });
    expect(screen.getByTestId('therapeutic-catalog-label-count')).toHaveTextContent('4/200');
    expect(screen.getByTestId('therapeutic-catalog-label-count')).not.toHaveClass('text-red-600');
  });

  it('passando de 200 o contador fica VERMELHO e o salvar desabilita — o operador vê antes de mandar', async () => {
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'a'.repeat(201) } });

    const contador = screen.getByTestId('therapeutic-catalog-label-count');
    expect(contador).toHaveTextContent('201/200');
    expect(contador).toHaveClass('text-red-600');
    expect(salvar()).toBeDisabled();
  });

  it('exatamente 200 ainda salva (o teto é do CHECK da migration 415, e é inclusivo)', async () => {
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'a'.repeat(200) } });

    expect(screen.getByTestId('therapeutic-catalog-label-count')).not.toHaveClass('text-red-600');
    expect(salvar()).not.toBeDisabled();
  });

  it('só espaços não é texto: continua desabilitado e o submit direto no form não chama onSave', async () => {
    const { container } = await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: '     ' } });
    expect(salvar()).toBeDisabled();

    // Submeter o form por fora do botão (Enter, extensão, teste) também não passa.
    fireEvent.submit(container.querySelector('form')!);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('TherapeuticCatalogFormModal — a ordem é opcional', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  it('ordem VAZIA não vai no corpo — o servidor decide a posição (vazio = no fim)', async () => {
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'Nueva opción' } });
    fireEvent.click(salvar());

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'Nueva opción' }));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('sortOrder');
  });

  it('ordem NUMÉRICA vai no corpo como número, não como string', async () => {
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: '  Nueva  ' } });
    fireEvent.change(ordemInput(), { target: { value: '12' } });
    fireEvent.click(salvar());

    // O rótulo vai trimado — o mesmo que o contador mostrou.
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'Nueva', sortOrder: 12 }));
  });

  it('ordem 0 é uma ordem válida (não pode cair no "vazio" por ser falsy)', async () => {
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'Primera' } });
    fireEvent.change(ordemInput(), { target: { value: '0' } });
    fireEvent.click(salvar());

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'Primera', sortOrder: 0 }));
  });

  it('ordem NÃO NUMÉRICA (1e999 → Infinity) é descartada em vez de virar um corpo inválido', async () => {
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'Nueva' } });
    fireEvent.change(ordemInput(), { target: { value: '1e999' } });
    fireEvent.click(salvar());

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'Nueva' }));
  });
});

describe('TherapeuticCatalogFormModal — salvar, e a recusa do servidor na tela', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  it('enquanto salva o botão vira "Salvando…" e o cancelar desabilita (nada de duplo POST)', async () => {
    let libera: () => void = () => {};
    onSave.mockImplementation(() => new Promise<void>((r) => { libera = r; }));
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'Nueva' } });
    fireEvent.click(salvar());

    await waitFor(() => expect(salvar()).toHaveTextContent(COPY.form.saving));
    expect(salvar()).toBeDisabled();
    expect(screen.getByRole('button', { name: ptBR.common.cancel })).toBeDisabled();

    await act(async () => { libera(); });
    await waitFor(() => expect(salvar()).toHaveTextContent(COPY.form.save));
  });

  it('409 do servidor vira a frase de DUPLICADO, não o inglês do backend', async () => {
    onSave.mockRejectedValue(Object.assign(new Error('Label already exists'), { status: 409 }));
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'Repetida' } });
    fireEvent.click(salvar());

    const erro = await screen.findByTestId('therapeutic-catalog-form-error');
    expect(erro).toHaveTextContent(COPY.errors.duplicate);
    expect(erro).toHaveAttribute('role', 'alert');
    expect(erro).not.toHaveTextContent('Label already exists');
  });

  it('400 vira a frase de dado pessoal no rótulo — a guarda é do SERVIDOR (lex C18)', async () => {
    onSave.mockRejectedValue(Object.assign(new Error('label contains personal data'), { status: 400 }));
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'juan@enlite.health' } });
    fireEvent.click(salvar());

    expect(await screen.findByTestId('therapeutic-catalog-form-error')).toHaveTextContent(COPY.errors.invalidLabel);
  });

  it('recusa DESCONHECIDA cai na mensagem do próprio erro — nunca vira tela muda', async () => {
    onSave.mockRejectedValue(Object.assign(new Error('brand new refusal'), { status: 503 }));
    await renderModal(null);
    fireEvent.change(textoInput(), { target: { value: 'Nueva' } });
    fireEvent.click(salvar());

    expect(await screen.findByTestId('therapeutic-catalog-form-error')).toHaveTextContent('brand new refusal');
    // E o formulário volta a aceitar uma nova tentativa.
    expect(salvar()).not.toBeDisabled();
  });

  it('sem erro na tela antes de tentar salvar', async () => {
    await renderModal(null);
    expect(screen.queryByTestId('therapeutic-catalog-form-error')).toBeNull();
  });
});

describe('TherapeuticCatalogFormModal — fechar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  it('o X fecha e não grava nada', async () => {
    await renderModal(item());
    fireEvent.click(screen.getByTestId('therapeutic-catalog-form-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('o X tem rótulo acessível traduzido (não "close" cru)', async () => {
    await renderModal(null);
    expect(screen.getByLabelText(ptBR.common.close)).toBe(screen.getByTestId('therapeutic-catalog-form-close'));
  });

  it('clicar no backdrop fecha e não grava nada', async () => {
    const { container } = await renderModal(null);
    fireEvent.click(container.querySelector('[aria-hidden="true"]')!);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('o botão Cancelar fecha', async () => {
    await renderModal(null);
    fireEvent.click(screen.getByRole('button', { name: ptBR.common.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('catalogRefusalMessage — a recusa em frase de tela', () => {
  it('409 → duplicado; 400 → dado pessoal (lex C18)', () => {
    expect(catalogRefusalMessage({ status: 409 }, t)).toBe(COPY.errors.duplicate);
    expect(catalogRefusalMessage({ status: 400 }, t)).toBe(COPY.errors.invalidLabel);
  });

  it('Error sem status usa a própria mensagem', () => {
    expect(catalogRefusalMessage(new Error('connection refused'), t)).toBe('connection refused');
  });

  it('rejeição que NÃO é objeto vira texto (string crua não some)', () => {
    expect(catalogRefusalMessage('sem message', t)).toBe('sem message');
  });

  it('`null` (typeof "object", mas sem status) não explode ao ler o status', () => {
    expect(catalogRefusalMessage(null, t)).toBe('null');
  });
});
