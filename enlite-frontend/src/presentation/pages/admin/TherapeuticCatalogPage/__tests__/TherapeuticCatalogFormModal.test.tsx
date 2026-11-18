/**
 * TherapeuticCatalogFormModal — criar/renomear uma opção de catálogo do projeto terapêutico
 * (spec 017, D299).
 *
 * i18n resolvido contra o pt-BR.json REAL (chave errada aparece como a própria chave e o teste
 * quebra). Nenhum mock além de i18n e do `onSave`/`onClose` que o pai injeta — a fronteira desta
 * peça é justamente esse par de callbacks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { selectCombo } from '@presentation/components/atoms/Combobox/testUtils';
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

const { TherapeuticCatalogFormModal } = await import('../TherapeuticCatalogFormModal');
const { catalogRefusalMessage } = await import('../catalogRefusalMessage');

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
  const utils = render(<TherapeuticCatalogFormModal kind="service-exit-reasons" item={alvo} onSave={onSave} onClose={onClose} />);
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
    const { unmount } = render(<TherapeuticCatalogFormModal kind="service-exit-reasons" item={null} onSave={onSave} onClose={onClose} />);
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

// ── 091 — Servicio (objetivo), Objetivo + Frecuencia (atividade); sem Segmento ──────────────────────

describe('TherapeuticCatalogFormModal — serviço, objetivo e frequência (091, DD-24)', () => {
  const OBJ_A = item({ id: 'o-a', label: 'Objetivo A SINTETICO', sortOrder: 1 });
  const OBJ_B = item({ id: 'o-b', label: 'Objetivo B SINTETICO', sortOrder: 2 });
  const OBJ_OFF = item({ id: 'o-off', label: 'Objetivo viejo SINTETICO', sortOrder: 3, active: false });
  const servicoSelect = () => screen.getByTestId('therapeutic-catalog-service-select');
  const objetivoSelect = () => screen.getByTestId('therapeutic-catalog-objective-select');
  const frecuencia = () => screen.getByTestId('therapeutic-catalog-frequency-input');

  async function renderKind091(kind: 'specific-objectives' | 'activities', alvo: TherapeuticCatalogItem | null) {
    const utils = render(<TherapeuticCatalogFormModal kind={kind} item={alvo} objectives={[OBJ_A, OBJ_B, OBJ_OFF]} onSave={onSave} onClose={onClose} />);
    await waitFor(() => expect(utils.container.querySelector('form')).toHaveClass('translate-x-0'));
    return utils;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  it('objetivo: o campo Servicio existe com os 2 serviços, e NÃO há Segmento, Objetivo nem Frecuencia', async () => {
    await renderKind091('specific-objectives', null);
    expect(screen.getByLabelText(COPY.service)).toBe(servicoSelect());
    fireEvent.click(servicoSelect());
    const rotulos = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(rotulos).toEqual([COPY.serviceAT, COPY.serviceCAREGIVER]);
    expect(screen.queryByTestId('therapeutic-catalog-segment-select')).toBeNull();
    expect(screen.queryByTestId('therapeutic-catalog-objective-select')).toBeNull();
    expect(screen.queryByTestId('therapeutic-catalog-frequency-input')).toBeNull();
  });

  it('objetivo: o serviço é OBRIGATÓRIO — sem ele Salvar fica desabilitado; com ele o corpo leva `serviceCode`', async () => {
    await renderKind091('specific-objectives', null);
    fireEvent.change(textoInput(), { target: { value: 'TITULO-SINTETICO-6' } });
    expect(salvar()).toBeDisabled();
    await selectCombo(servicoSelect(), COPY.serviceCAREGIVER);
    expect(salvar()).not.toBeDisabled();
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'TITULO-SINTETICO-6', serviceCode: 'CAREGIVER' }));
  });

  it('objetivo em edição: serviço não alterado = chave AUSENTE; trocado = viaja', async () => {
    const { unmount } = await renderKind091('specific-objectives', item({ serviceCode: 'AT' }));
    expect(servicoSelect()).toHaveTextContent(COPY.serviceAT);
    fireEvent.change(textoInput(), { target: { value: 'Otro titulo SINTETICO' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'Otro titulo SINTETICO' }));
    expect(Object.keys(onSave.mock.calls[0][0])).not.toContain('serviceCode');
    unmount();

    onSave.mockClear();
    await renderKind091('specific-objectives', item({ serviceCode: 'AT' }));
    await selectCombo(servicoSelect(), COPY.serviceCAREGIVER);
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ serviceCode: 'CAREGIVER' }));
  });

  it('atividade: Objetivo (só ativos) + Frecuencia; sem Servicio e sem Segmento', async () => {
    await renderKind091('activities', null);
    expect(screen.getByLabelText(COPY.objective)).toBe(objetivoSelect());
    expect(screen.getByLabelText(COPY.frequency)).toBe(frecuencia());
    fireEvent.click(objetivoSelect());
    const rotulos = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(rotulos).toEqual([OBJ_A.label, OBJ_B.label]);
    expect(screen.queryByTestId('therapeutic-catalog-service-select')).toBeNull();
    expect(screen.queryByTestId('therapeutic-catalog-segment-select')).toBeNull();
  });

  it('atividade: o objetivo é OBRIGATÓRIO; criar manda `objectiveId` e a frequência digitada (trimada)', async () => {
    await renderKind091('activities', null);
    fireEvent.change(textoInput(), { target: { value: 'ATIVIDADE-SINTETICA-1' } });
    expect(salvar()).toBeDisabled();
    await selectCombo(objetivoSelect(), OBJ_B.label);
    expect(salvar()).not.toBeDisabled();
    fireEvent.change(frecuencia(), { target: { value: '  3 veces por semana  ' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'ATIVIDADE-SINTETICA-1', objectiveId: 'o-b', suggestedFrequency: '3 veces por semana' }));
  });

  it('atividade: criar sem mexer na frequência = chave AUSENTE (não manda null à toa)', async () => {
    await renderKind091('activities', null);
    fireEvent.change(textoInput(), { target: { value: 'ATIVIDADE-SINTETICA-2' } });
    await selectCombo(objetivoSelect(), OBJ_A.label);
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'ATIVIDADE-SINTETICA-2', objectiveId: 'o-a' }));
    expect(Object.keys(onSave.mock.calls[0][0])).not.toContain('suggestedFrequency');
  });

  it('DD-24: esvaziar a frequência de uma atividade que tinha manda `suggestedFrequency: null` EXPLÍCITO (só ela viaja)', async () => {
    await renderKind091('activities', item({ objectiveId: 'o-a', suggestedFrequency: 'Diaria' }));
    expect(frecuencia()).toHaveValue('Diaria');
    fireEvent.change(frecuencia(), { target: { value: '   ' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ suggestedFrequency: null }));
    expect(onSave.mock.calls[0][0]).toHaveProperty('suggestedFrequency', null);
  });

  it('DD-24: frequência e objetivo não alterados = chaves AUSENTES; editar sem mudar nada = Salvar desabilitado', async () => {
    await renderKind091('activities', item({ objectiveId: 'o-a', suggestedFrequency: 'Diaria', description: 'DESCRIPCION-SINTETICA-6' }));
    expect(salvar()).toBeDisabled();
    fireEvent.change(textoInput(), { target: { value: 'Otro titulo SINTETICO' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'Otro titulo SINTETICO' }));
    const chaves = Object.keys(onSave.mock.calls[0][0]);
    expect(chaves).not.toContain('suggestedFrequency');
    expect(chaves).not.toContain('objectiveId');
  });

  it('atividade em edição: trocar o objetivo viaja `objectiveId`; objetivo INATIVO atual aparece com a marca de inativo', async () => {
    await renderKind091('activities', item({ objectiveId: 'o-off', suggestedFrequency: 'Diaria' }));
    expect(objetivoSelect()).toHaveTextContent(`${OBJ_OFF.label} (${COPY.inactive})`);
    await selectCombo(objetivoSelect(), OBJ_A.label);
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ objectiveId: 'o-a' }));
  });

  it('a frequência passa de 100: contador vermelho e Salvar desabilitado; 100 ainda salva', async () => {
    await renderKind091('activities', item({ objectiveId: 'o-a', suggestedFrequency: null }));
    fireEvent.change(frecuencia(), { target: { value: 'f'.repeat(101) } });
    expect(screen.getByTestId('therapeutic-catalog-frequency-count')).toHaveTextContent('101/100');
    expect(screen.getByTestId('therapeutic-catalog-frequency-count')).toHaveClass('text-red-600');
    expect(salvar()).toBeDisabled();
    fireEvent.change(frecuencia(), { target: { value: 'f'.repeat(100) } });
    expect(salvar()).not.toBeDisabled();
  });

  it('motivos de saída: sem Servicio, Objetivo, Frecuencia nem Segmento', async () => {
    await renderModal(null);
    for (const id of ['service-select', 'objective-select', 'frequency-input', 'segment-select']) {
      expect(screen.queryByTestId(`therapeutic-catalog-${id}`)).toBeNull();
    }
  });
});

// ── Spec 061 — objetivo/atividade: título 150 + descrição 1000, sem Ordem ───────────────────────────

describe('TherapeuticCatalogFormModal — título e descrição (spec 061)', () => {
  const descInput = () => screen.getByTestId('therapeutic-catalog-description-input');
  const descCount = () => screen.getByTestId('therapeutic-catalog-description-count');
  const labelCount = () => screen.getByTestId('therapeutic-catalog-label-count');

  // 091: objetivo/atividade exigem dono — item existente já o traz (inalterado = chave ausente); criação escolhe pelo select.
  const OBJ_DONO = item({ id: 'o1', label: 'Objetivo dono SINTETICO' });
  async function renderKind(kind: 'activities' | 'specific-objectives' | 'service-exit-reasons', alvo: TherapeuticCatalogItem | null) {
    const comDono = alvo && { serviceCode: 'AT', objectiveId: 'o1', ...alvo };
    const utils = render(<TherapeuticCatalogFormModal kind={kind} item={comDono} objectives={[OBJ_DONO]} onSave={onSave} onClose={onClose} />);
    await waitFor(() => expect(utils.container.querySelector('form')).toHaveClass('translate-x-0'));
    if (!comDono && kind === 'activities') await selectCombo(screen.getByTestId('therapeutic-catalog-objective-select'), OBJ_DONO.label);
    if (!comDono && kind === 'specific-objectives') await selectCombo(screen.getByTestId('therapeutic-catalog-service-select'), COPY.serviceAT);
    return utils;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  it.each(['activities', 'specific-objectives'] as const)('%s: NÃO existe o input de ordem nem a ajuda; existe a descrição', async (kind) => {
    await renderKind(kind, item({ sortOrder: 7 }));
    expect(screen.queryByTestId('therapeutic-catalog-order-input')).toBeNull();
    expect(screen.queryByText(COPY.form.sortOrderHelp)).toBeNull();
    expect(screen.getByLabelText(COPY.form.title)).toBe(textoInput());
    expect(screen.getByLabelText(COPY.form.description)).toBe(descInput());
  });

  it('motivos de saída: o input de ordem continua e NÃO há descrição', async () => {
    await renderKind('service-exit-reasons', item());
    expect(ordemInput()).toHaveValue(7);
    expect(screen.queryByTestId('therapeutic-catalog-description-input')).toBeNull();
  });

  it('criar: título e descrição digitados vão no onSave; contadores n/150 e n/1000', async () => {
    await renderKind('activities', null);
    expect(labelCount()).toHaveTextContent('0/150');
    expect(descCount()).toHaveTextContent('0/1000');
    fireEvent.change(textoInput(), { target: { value: 'TITULO-SINTETICO-1' } });
    fireEvent.change(descInput(), { target: { value: '  DESCRIPCION-SINTETICA-1  ' } });
    expect(descCount()).toHaveTextContent('23/1000');
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: 'TITULO-SINTETICO-1', description: 'DESCRIPCION-SINTETICA-1', objectiveId: 'o1' }));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('sortOrder');
  });

  it('criar com título de 151 desabilita Salvar (150 ainda salva)', async () => {
    await renderKind('activities', null);
    fireEvent.change(textoInput(), { target: { value: 'a'.repeat(151) } });
    expect(labelCount()).toHaveTextContent('151/150');
    expect(labelCount()).toHaveClass('text-red-600');
    expect(salvar()).toBeDisabled();
    fireEvent.change(textoInput(), { target: { value: 'a'.repeat(150) } });
    expect(salvar()).not.toBeDisabled();
  });

  it('descrição de 1001 desabilita Salvar; 1000 salva', async () => {
    await renderKind('specific-objectives', null);
    fireEvent.change(textoInput(), { target: { value: 'TITULO-SINTETICO-2' } });
    fireEvent.change(descInput(), { target: { value: 'd'.repeat(1001) } });
    expect(descCount()).toHaveClass('text-red-600');
    expect(salvar()).toBeDisabled();
    fireEvent.change(descInput(), { target: { value: 'd'.repeat(1000) } });
    expect(salvar()).not.toBeDisabled();
  });

  it('item ANTIGO com título de 155: mudar só a descrição habilita Salvar e o payload NÃO leva label', async () => {
    const antigo = 'T'.repeat(155);
    await renderKind('activities', item({ label: antigo, description: null }));
    expect(labelCount()).toHaveTextContent('155/150');
    expect(labelCount()).not.toHaveClass('text-red-600');
    fireEvent.change(descInput(), { target: { value: 'DESCRIPCION-SINTETICA-3' } });
    expect(salvar()).not.toBeDisabled();
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ description: 'DESCRIPCION-SINTETICA-3' }));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('label');
  });

  it('renomear o item de 155 para 151 desabilita Salvar (título mudou, teto vale)', async () => {
    await renderKind('activities', item({ label: 'T'.repeat(155) }));
    fireEvent.change(textoInput(), { target: { value: 'U'.repeat(151) } });
    expect(labelCount()).toHaveClass('text-red-600');
    expect(salvar()).toBeDisabled();
  });

  it('esvaziar a descrição de um item que tinha manda `description: null` (limpa)', async () => {
    await renderKind('activities', item({ description: 'DESCRIPCION-SINTETICA-4' }));
    expect(descInput()).toHaveValue('DESCRIPCION-SINTETICA-4');
    fireEvent.change(descInput(), { target: { value: '   ' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ description: null }));
  });

  it('editar sem mudar nada: nada a salvar (Salvar desabilitado, sem PATCH vazio)', async () => {
    await renderKind('activities', item({ description: 'DESCRIPCION-SINTETICA-5' }));
    expect(salvar()).toBeDisabled();
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

describe('TherapeuticCatalogFormModal — guardia predefinida (spec 074)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSave.mockResolvedValue(undefined);
  });

  async function renderGuardia() {
    const utils = render(<TherapeuticCatalogFormModal kind="service-shift-templates" item={null} onSave={onSave} onClose={onClose} />);
    await waitFor(() => expect(utils.container.querySelector('form')).toHaveClass('translate-x-0'));
    return utils;
  }

  it('M1 guardia: salvar envia items', async () => {
    await renderGuardia();
    fireEvent.change(textoInput(), { target: { value: 'Guardia 6 + 6' } });
    fireEvent.click(screen.getByTestId('shift-template-add'));
    fireEvent.click(screen.getByTestId('svc-shift-allday-0'));
    expect(screen.getByTestId('therapeutic-catalog-not-retroactive')).toHaveTextContent(COPY.shiftTemplates.notRetroactive);
    expect(screen.queryByTestId('therapeutic-catalog-order-input')).toBeNull();
    await act(async () => { fireEvent.click(salvar()); });
    expect(onSave).toHaveBeenCalledWith({ label: 'Guardia 6 + 6', items: [{ startTime: '09:00', durationMinutes: 1440 }] });
  });

  it('M2 guardia sem turno: salvar desabilitado', async () => {
    await renderGuardia();
    fireEvent.change(textoInput(), { target: { value: 'Guardia vacía' } });
    expect(salvar()).toBeDisabled();
  });

  it('M3 guardia: 422 de sobreposição mostra a mensagem e o modal fica aberto', async () => {
    onSave.mockRejectedValue(Object.assign(new Error('Shift template items overlap'), { status: 422, code: 'SHIFT_TEMPLATE_ITEMS_OVERLAP' }));
    await renderGuardia();
    fireEvent.change(textoInput(), { target: { value: 'Guardia solapada' } });
    fireEvent.click(screen.getByTestId('shift-template-add'));
    await act(async () => { fireEvent.click(salvar()); });
    expect(await screen.findByTestId('therapeutic-catalog-form-error')).toHaveTextContent(COPY.shiftTemplates.overlap);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('therapeutic-catalog-form-modal')).toBeInTheDocument();
  });
});
