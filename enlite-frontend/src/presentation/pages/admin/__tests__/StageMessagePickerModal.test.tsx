/**
 * StageMessagePickerModal.test.tsx — a tela de ESCOLHA da mensagem.
 * O que se afirma: a prévia mostra o texto aprovado com os valores de exemplo,
 * o corpo-ponteiro nunca vira prévia, os inelegíveis aparecem agrupados por
 * motivo (sem clique) e a busca só existe quando a lista passa do teto.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StageMessagePickerModal } from '../StageMessagePickerModal';
import { previewTextOf, summaryOf, placeholdersOf, SEARCH_THRESHOLD } from '../stageMessagePreview';
import type { FunnelStageTemplateOption } from '@infrastructure/http/AdminFunnelStageMessagesApiService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key) }),
}));

const tpl = (over: Partial<FunnelStageTemplateOption>): FunnelStageTemplateOption => ({
  slug: 's', name: 'n', body: null, bodyTwilio: null, category: 'UTILITY', eligible: true, reason: null, placeholders: [], unsupported: [], ...over,
});

const OK = tpl({ slug: 'ok_tpl', body: 'Caso {{case_number}} para {{worker_name}}', bodyTwilio: 'Caso {{1}} para {{2}}' });
const SIN = tpl({ slug: 'sin_texto', body: '(ver Twilio Content Builder: HX54d6)', bodyTwilio: null });
const MKT = tpl({ slug: 'mkt', eligible: false, reason: 'CATEGORY', body: 'x' });
const POS = tpl({ slug: 'pos', eligible: false, reason: 'PLACEHOLDERS', body: 'Hola {{1}}' });

function renderModal(over: Partial<Parameters<typeof StageMessagePickerModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <StageMessagePickerModal
      stageLabel="Pre Screening"
      templates={[OK, SIN, MKT, POS]}
      initialSlug=""
      initialEnabled={false}
      saving={false}
      canSave
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onCancel };
}

describe('previewTextOf / summaryOf', () => {
  it('usa o corpo APROVADO e resolve {{1}} pelo nome na mesma ordem de `body`', () => {
    expect(previewTextOf(OK)).toBe('Caso CASO 1042 para María González');
  });

  it('sem corpo aprovado, cai para o nosso `body` nomeado', () => {
    expect(previewTextOf(tpl({ body: 'Hola {{name}}', bodyTwilio: null }))).toBe('Hola María González');
  });

  it('corpo-ponteiro e corpo vazio não viram prévia — null, para a tela dizer que não sabe', () => {
    expect(previewTextOf(SIN)).toBeNull();
    expect(previewTextOf(tpl({ body: '[Template aprovado Twilio — conteúdo gerenciado via Content API]' }))).toBeNull();
    expect(previewTextOf(tpl({ body: '   ', bodyTwilio: null }))).toBeNull();
    expect(previewTextOf(tpl({ body: null, bodyTwilio: null }))).toBeNull();
  });

  it('variável fora da allowlist aparece marcada, não sumida', () => {
    expect(previewTextOf(tpl({ body: 'El {{date}}', bodyTwilio: null }))).toBe('El «date»');
    // posicional sem nome correspondente em `body` mantém o número visível
    expect(previewTextOf(tpl({ body: '', bodyTwilio: 'Hola {{1}}' }))).toBe('Hola «1»');
  });

  it('summaryOf achata quebras de linha; sem texto → null', () => {
    expect(summaryOf(tpl({ body: 'uma\n\nlinha só', bodyTwilio: null }))).toBe('uma linha só');
    expect(summaryOf(SIN)).toBeNull();
  });

  it('placeholdersOf devolve sem duplicata, na ordem, tolerando espaço', () => {
    expect(placeholdersOf('{{ a }} {{b}} {{a}}')).toEqual(['a', 'b']);
    expect(placeholdersOf('')).toEqual([]);
  });
});

describe('StageMessagePickerModal', () => {
  it('mostra só os elegíveis como opção, com o texto como identidade e o slug embaixo', () => {
    renderModal();
    expect(screen.getByTestId('fsm-option-ok_tpl')).toHaveTextContent('«Caso CASO 1042 para María González»');
    expect(screen.getByTestId('fsm-option-ok_tpl')).toHaveTextContent('ok_tpl');
    expect(screen.getByTestId('fsm-option-sin_texto')).toHaveTextContent('admin.funnelStageMessages.picker.noText');
    expect(screen.queryByTestId('fsm-option-mkt')).toBeNull();
  });

  it('os inelegíveis aparecem SEM clique, agrupados por motivo e com contagem', () => {
    renderModal();
    expect(screen.getByTestId('fsm-blocked-list')).toBeInTheDocument();
    expect(screen.getByTestId('fsm-blocked-CATEGORY')).toHaveTextContent('mkt');
    expect(screen.getByTestId('fsm-blocked-CATEGORY')).toHaveTextContent('ineligible.CATEGORY');
    expect(screen.getByTestId('fsm-blocked-PLACEHOLDERS')).toHaveTextContent('pos');
    expect(screen.queryByTestId('fsm-modal-toggle-blocked')).toBeNull();
  });

  it('inelegível sem motivo declarado cai em PLACEHOLDERS, nunca some da lista', () => {
    renderModal({ templates: [tpl({ slug: 'orfao', eligible: false, reason: null })] });
    expect(screen.getByTestId('fsm-blocked-PLACEHOLDERS')).toHaveTextContent('orfao');
  });

  it('escolher mostra a prévia; escolher o sem-texto mostra o aviso, não o ponteiro', () => {
    renderModal();
    expect(screen.getByTestId('fsm-preview-none')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fsm-option-ok_tpl'));
    expect(screen.getByTestId('fsm-preview')).toHaveTextContent('Caso CASO 1042 para María González');
    fireEvent.click(screen.getByTestId('fsm-option-sin_texto'));
    expect(screen.getByTestId('fsm-preview-unsynced')).toBeInTheDocument();
    expect(screen.queryByTestId('fsm-preview')).toBeNull();
  });

  it(`a busca só aparece acima de ${SEARCH_THRESHOLD} elegíveis — e filtra por texto e por slug`, () => {
    renderModal();
    expect(screen.queryByTestId('fsm-modal-search')).toBeNull();

    const many = Array.from({ length: SEARCH_THRESHOLD + 1 }, (_, i) => tpl({ slug: `t${i}`, body: i === 0 ? 'Bienvenida al caso' : `Otro ${i}` }));
    renderModal({ templates: many });
    const search = screen.getByTestId('fsm-modal-search');
    fireEvent.change(search, { target: { value: 'bienvenida' } });
    expect(screen.getByTestId('fsm-option-t0')).toBeInTheDocument();
    expect(screen.queryByTestId('fsm-option-t1')).toBeNull();

    fireEvent.change(search, { target: { value: 't5' } });
    expect(screen.getByTestId('fsm-option-t5')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByTestId('fsm-modal-empty')).toBeInTheDocument();
  });

  it('busca com elegível SEM texto não quebra: casa pelo slug', () => {
    const many = [SIN, ...Array.from({ length: SEARCH_THRESHOLD }, (_, i) => tpl({ slug: `t${i}`, body: `Otro ${i}` }))];
    renderModal({ templates: many });
    fireEvent.change(screen.getByTestId('fsm-modal-search'), { target: { value: 'sin_' } });
    expect(screen.getByTestId('fsm-option-sin_texto')).toBeInTheDocument();
    expect(screen.queryByTestId('fsm-option-t0')).toBeNull();
  });

  it('mensagem longa é cortada no cartão da opção, com reticências', () => {
    const longo = 'a'.repeat(120);
    renderModal({ templates: [tpl({ slug: 'longo', body: longo })] });
    const opt = screen.getByTestId('fsm-option-longo');
    expect(opt).toHaveTextContent(`«${'a'.repeat(70)}…»`);
    expect(opt.textContent).not.toContain('a'.repeat(71));
  });

  it('confirma com a escolha e o estado do checkbox; ligar sem mensagem é impossível', () => {
    const { onConfirm } = renderModal({ initialSlug: 'ok_tpl', initialEnabled: true });
    fireEvent.click(screen.getByTestId('fsm-modal-save'));
    expect(onConfirm).toHaveBeenCalledWith('ok_tpl', true);

    fireEvent.click(screen.getByTestId('fsm-option-ok_tpl')); // desmarca
    fireEvent.click(screen.getByTestId('fsm-modal-save'));
    expect(onConfirm).toHaveBeenLastCalledWith('', false);
  });

  it('salvando desabilita o botão e mostra o rótulo de progresso', () => {
    renderModal({ saving: true });
    const save = screen.getByTestId('fsm-modal-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save).toHaveTextContent('admin.funnelStageMessages.saving');
  });

  it('o X fecha', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByLabelText('admin.funnelStageMessages.picker.close'));
    expect(onCancel).toHaveBeenCalled();
  });
});
