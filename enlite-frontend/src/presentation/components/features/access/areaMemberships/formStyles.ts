/**
 * Desvios do protótipo "Vínculos de área" que valem SÓ nesta aba (decisão 2 da change) — classes locais,
 * nunca token global. Cada uma leva `!` porque a do atom perde em silêncio (CLAUDE.md, Tipografia).
 */

/** Valor escolhido do Combobox `dense`: 13px/400 em índigo, como o `<select class="inp">` do desenho. */
export const DENSE_COMBO_VALUE = 'text-primary !text-[13px] !font-normal !leading-[normal]';

/** Placeholder do campo de busca: #595959 (7:1) em vez de #737373 a 60% (2,3:1). */
export const DENSE_PLACEHOLDER = 'placeholder:!text-[#595959]';

/** Botão de 35px, a altura do campo `dense` ao lado (o `compact` do atom tem 38px). */
export const BUTTON_35 = '!h-[35px]';
