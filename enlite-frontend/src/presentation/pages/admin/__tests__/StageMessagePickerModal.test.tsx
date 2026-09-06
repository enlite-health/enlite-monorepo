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

  it('SEM texto aprovado não há prévia — nem quando o nosso `body` tem texto', () => {
    // A regra que mata a classe: a prévia lê só `bodyTwilio`. Assim nenhum
    // sentinela (nem os que ainda não existem) tem por onde chegar à tela.
    expect(previewTextOf(tpl({ body: 'Hola {{name}}', bodyTwilio: null }))).toBeNull();
    expect(previewTextOf(SIN)).toBeNull();
    expect(previewTextOf(tpl({ body: '[Template aprovado Twilio — conteúdo gerenciado via Content API]' }))).toBeNull();
    expect(previewTextOf(tpl({ body: '[Template não-textual — popular body manualmente]' }))).toBeNull();
    expect(previewTextOf(tpl({ body: null, bodyTwilio: null }))).toBeNull();
    expect(previewTextOf(tpl({ body: 'x', bodyTwilio: '   ' }))).toBeNull();
  });

  it('qualquer sentinela futuro em `body` é inalcançável pela tela — a regra não depende de reconhecê-lo', () => {
    for (const inventado of ['<<TEMPLATE SEM TEXTO>>', 'TODO: preencher', '{{{ponteiro}}}', 'ver no Twilio']) {
      expect(previewTextOf(tpl({ body: inventado, bodyTwilio: null }))).toBeNull();
    }
  });

  it('variável fora da allowlist aparece marcada, não sumida', () => {
    expect(previewTextOf(tpl({ body: 'El {{date}}', bodyTwilio: 'El {{1}}' }))).toBe('El «date»');
    // posicional sem nome correspondente em `body` mantém o número visível
    expect(previewTextOf(tpl({ body: '', bodyTwilio: 'Hola {{1}}' }))).toBe('Hola «1»');
  });

  it('summaryOf achata quebras de linha; sem texto → null', () => {
    expect(summaryOf(tpl({ body: 'x', bodyTwilio: 'uma\n\nlinha só' }))).toBe('uma linha só');
    expect(summaryOf(SIN)).toBeNull();
  });

  it('placeholdersOf devolve sem duplicata, na ordem, tolerando espaço', () => {
    expect(placeholdersOf('{{ a }} {{b}} {{a}}')).toEqual(['a', 'b']);
    expect(placeholdersOf('')).toEqual([]);
  });

  it('slot inválido ou token estranho fica literal — a tela não finge que resolveu', () => {
    // `constructor` vem do PROTÓTIPO: sem Object.hasOwn, isto imprimiria
    // "function Object() { [native code] }" dentro do balão da mensagem.
    expect(previewTextOf(tpl({ body: '', bodyTwilio: 'Hola {{constructor}}' }))).toBe('Hola «constructor»');
    expect(previewTextOf(tpl({ body: 'x {{case_number}}', bodyTwilio: 'Caso {{0}} e {{1}}' }))).toBe('Caso «0» e CASO 1042');
    expect(previewTextOf(tpl({ body: '', bodyTwilio: 'Hola {{first-name}}' }))).toBe('Hola {{first-name}}');
  });

  it('CONTRATO com o backend: o parser aceita só [A-Za-z0-9_] — o que o envio enxerga', () => {
    // Se o front aceitasse `{{first-name}}` e o backend não, a prévia diria que o
    // valor cai no slot 2 e o envio o poria no slot 1. Este caso trava os dois.
    expect(placeholdersOf('Hola {{first-name}}, caso {{case_number}}')).toEqual(['case_number']);
    expect(placeholdersOf('{{a.b}} {{c}}')).toEqual(['c']);
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

  it('etapa configurada com template que VIROU inelegível: a modal diz, mostra o motivo e trava o Guardar', () => {
    // É o cenário que o SLOT_MISMATCH cria: a etapa foi ligada quando o template
    // era elegível, e o texto aprovado chegou depois. Procurando `selected` só
    // entre os elegíveis, a modal abria como se nada estivesse configurado — e
    // Guardar reenviava o slug bloqueado, que o backend recusa com 400.
    const { onConfirm } = renderModal({ initialSlug: 'pos', initialEnabled: true });
    expect(screen.getByTestId('fsm-current-blocked')).toHaveTextContent('pos');
    expect(screen.getByTestId('fsm-current-blocked')).toHaveTextContent('ineligible.PLACEHOLDERS');
    expect((screen.getByTestId('fsm-modal-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('fsm-save-blocked')).toBeInTheDocument();

    // escolher um elegível destrava
    fireEvent.click(screen.getByTestId('fsm-option-ok_tpl'));
    expect(screen.queryByTestId('fsm-current-blocked')).toBeNull();
    expect((screen.getByTestId('fsm-modal-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('fsm-modal-save'));
    expect(onConfirm).toHaveBeenCalledWith('ok_tpl', true);
  });

  it('slug configurado que NÃO está na lista (template desativado) também é bloqueado', () => {
    // O `list` do backend devolve só `is_active = true`. Um template desativado
    // depois de a etapa ser ligada não chega à modal: `selected` fica null. Antes,
    // isso deixava Guardar habilitado e o PUT voltava 400 "not found or inactive".
    renderModal({ initialSlug: 'sumiu_da_lista', initialEnabled: true });
    expect(screen.getByTestId('fsm-current-blocked')).toHaveTextContent('sumiu_da_lista');
    expect(screen.getByTestId('fsm-current-blocked')).toHaveTextContent('picker.notAvailable');
    expect((screen.getByTestId('fsm-modal-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('bloqueado SEM motivo declarado cai em PLACEHOLDERS — nunca fica sem explicação', () => {
    renderModal({ templates: [tpl({ slug: 'orfao', eligible: false, reason: null })], initialSlug: 'orfao' });
    expect(screen.getByTestId('fsm-current-blocked')).toHaveTextContent('ineligible.PLACEHOLDERS');
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

    const many = Array.from({ length: SEARCH_THRESHOLD + 1 }, (_, i) => tpl({ slug: `t${i}`, bodyTwilio: i === 0 ? 'Bienvenida al caso' : `Otro ${i}` }));
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
    const many = [SIN, ...Array.from({ length: SEARCH_THRESHOLD }, (_, i) => tpl({ slug: `t${i}`, bodyTwilio: `Otro ${i}` }))];
    renderModal({ templates: many });
    fireEvent.change(screen.getByTestId('fsm-modal-search'), { target: { value: 'sin_' } });
    expect(screen.getByTestId('fsm-option-sin_texto')).toBeInTheDocument();
    expect(screen.queryByTestId('fsm-option-t0')).toBeNull();
  });

  it('mensagem longa é cortada no cartão da opção, com reticências', () => {
    const longo = 'a'.repeat(120);
    renderModal({ templates: [tpl({ slug: 'longo', bodyTwilio: longo })] });
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
