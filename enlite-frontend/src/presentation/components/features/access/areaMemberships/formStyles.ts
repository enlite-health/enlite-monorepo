/**
 * Desvios do protótipo "Vínculos de área" que valem SÓ nesta aba (decisão 2 da change) — classes locais,
 * nunca token global. Cada uma leva `!` porque a do atom perde em silêncio (CLAUDE.md, Tipografia).
 */

/** Valor escolhido do Combobox `dense`: 13px/400 em índigo, como o `<select class="inp">` do desenho. */
export const DENSE_COMBO_VALUE = 'text-primary !text-[13px] !font-normal !leading-[normal] relative top-px';

/** Placeholder do campo de busca: #595959 (7:1) em vez de #737373 a 60% (2,3:1). */
export const DENSE_PLACEHOLDER = 'placeholder:!text-[#595959]';

/** Botão de 35px, a altura do campo `dense` ao lado (o `compact` do atom tem 38px). */
export const BUTTON_35 = '!h-[35px]';

/** Seta do Combobox a 16px e, desabilitado, borda sólida + seta #737373 (o atom põe tracejado e #D9D9D9) — o `<select disabled>` do desenho não muda de aparência; (o atom desenha 20px; o `<select>` do desenho tem 16px) — por seletor, sem mexer no atom. */
export const DENSE_CHEVRON = '[&_button>svg]:!w-4 [&_button>svg]:!h-4 [&_button>svg]:!-mr-[3px] [&_button>svg]:translate-y-px [&_button:disabled]:!border-solid [&_button:disabled>svg]:!text-[#737373]';

/** Anel de foco só pelo teclado: depois de um clique do mouse o botão não fica "aceso" (o desenho recria o DOM e perde o foco). */
export const FOCUS_RING_KEYBOARD_ONLY = 'focus:!ring-0 focus-visible:!ring-2';
