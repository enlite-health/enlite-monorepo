// Fonte única de verdade visual para inputs, textareas e selects.
// Para adicionar um novo tamanho: basta inserir uma nova entrada em INPUT_SIZE_CONFIG.

export type InputSize = 'default' | 'compact' | 'dense';

interface SizeConfig {
  height: string;
  padding: string;
  fontSize: string;
  lineHeight: string;
  borderRadius: string;
  /**
   * 🔒 A COR SAIU DO BLOCO BASE e virou token de tamanho, pelo mesmo motivo que
   * o peso saiu do base do botão: `dense` precisa de tinta escura (#180149, a
   * do desenho de plantillas) e o base fixava #737373. Duas utilitárias de
   * `color` na mesma classe, e quem vence depende da ordem em que o Tailwind
   * emite — não da ordem em que foram escritas. `default` e `compact` seguem no
   * cinza de sempre: nenhum uso existente muda.
   */
  textColor: string;
  borderWidth: string;
  fontWeight: string;
  /**
   * Padding do TEXTAREA quando difere do input. Um campo de uma linha com
   * altura fixa e uma área de várias linhas não respiram igual: no desenho o
   * `.inp` tem 9px em cima e o `.editor` tem 12px.
   */
  paddingArea?: string;
  /**
   * Entrelinha do TEXTAREA quando difere do input.
   *
   * 🔒 Um token não serve dois donos: o `.inp` da maquete não declara
   * entrelinha (fica `normal`, e num campo de uma linha com altura fixa isso
   * não muda nada), enquanto o `.editor` usa 1,62 — que é o que faz texto de
   * várias linhas respirar. Enquanto era um valor só, corrigir um quebrava o
   * outro e o score ficava parado.
   */
  lineHeightArea?: string;
}

export const INPUT_SIZE_CONFIG: Record<InputSize, SizeConfig> = {
  default: {
    height: 'h-[60px]',
    padding: 'px-5 py-3',
    fontSize: 'text-[20px]',
    lineHeight: 'leading-[1.3]',
    borderRadius: 'rounded-[10px]',
    textColor: 'text-[#737373] placeholder:text-[#737373]/60',
    borderWidth: 'border-2',
    fontWeight: 'font-medium',
  },
  compact: {
    height: 'h-12',
    padding: 'px-4 py-2',
    fontSize: 'text-sm',
    lineHeight: 'leading-[1.3]',
    borderRadius: 'rounded-[10px]',
    textColor: 'text-[#737373] placeholder:text-[#737373]/60',
    borderWidth: 'border-[1.5px]',
    fontWeight: 'font-medium',
  },
  /**
   * 🔒 `dense` — os números medidos da maquete "Registro de Plantillas": o
   * `.inp` dela é `padding: 9px 13px; font-size: 13px; border: 1px` e mede
   * 35px de altura. `compact`, o menor que existia, é 48px com texto cinza de
   * 14px — e o pixel-loop reprovou por 13px de diferença de altura, o único
   * BLOQUEANTE da primeira medição.
   *
   * A tinta é escura de propósito: o campo do desenho mostra o valor digitado
   * como conteúdo, não como placeholder acinzentado.
   */
  dense: {
    height: 'h-[35px]',
    padding: 'px-[13px] py-[9px]',
    fontSize: 'text-[13px]',
    // ⚠️ `leading-[normal]`, entre colchetes, e NÃO `leading-normal`: a classe
    // nomeada do Tailwind é 1,5 (19,5px sobre 13), enquanto o `.inp` da maquete
    // não declara entrelinha e fica na palavra-chave `normal` do CSS (~1,2). São
    // coisas diferentes com nomes quase iguais — medido, não suposto.
    lineHeight: 'leading-[normal]',
    borderRadius: 'rounded-[10px]',
    textColor: 'text-primary placeholder:text-[#737373]/60',
    borderWidth: 'border',
    // 🔒 Peso 400, não 500. O `.inp` da maquete herda o peso do corpo; o base
    // do atom fixava `font-medium`, e um `font-normal` por fora colidiria.
    fontWeight: 'font-normal',
    paddingArea: 'px-[13px] py-[12px]',
    lineHeightArea: 'leading-[1.62]',
  },
};

const BASE_CLASSES =
  "w-full bg-white font-['Lexend'] focus:outline-none transition-colors border-solid";

const DEFAULT_BORDER = 'border-[#d9d9d9]';
const ERROR_BORDER = 'border-red-500';
const FOCUS_BORDER = 'focus:border-[#180149]';
const DISABLED_CLASSES = 'bg-[#f3f4f6] cursor-not-allowed';

export interface InputClassesOpts {
  size?: InputSize;
  error?: boolean;
  disabled?: boolean;
  omitHeight?: boolean;
  /** É textarea: usa `paddingArea` quando o tamanho define um. */
  area?: boolean;
}

export function inputBaseClasses(opts: InputClassesOpts = {}): string {
  const { size = 'default', error = false, disabled = false, omitHeight = false } = opts;
  const config = INPUT_SIZE_CONFIG[size];

  const borderColor = error ? ERROR_BORDER : DEFAULT_BORDER;
  const focusClass = error ? '' : FOCUS_BORDER;
  const disabledClass = disabled ? DISABLED_CLASSES : '';

  const height = omitHeight ? '' : config.height;

  return [
    BASE_CLASSES,
    height,
    opts.area && config.paddingArea ? config.paddingArea : config.padding,
    config.fontSize,
    opts.area && config.lineHeightArea ? config.lineHeightArea : config.lineHeight,
    config.borderRadius,
    config.textColor,
    config.borderWidth,
    config.fontWeight,
    borderColor,
    focusClass,
    disabledClass,
  ]
    .filter(Boolean)
    .join(' ');
}

export function textareaBaseClasses(opts: Omit<InputClassesOpts, 'omitHeight' | 'area'> = {}): string {
  return inputBaseClasses({ ...opts, omitHeight: true, area: true });
}

export interface WrapperClassesOpts {
  size?: InputSize;
  error?: boolean;
  disabled?: boolean;
}

export function inputWrapperClasses(opts: WrapperClassesOpts = {}): string {
  const { size = 'default', error = false, disabled = false } = opts;
  const config = INPUT_SIZE_CONFIG[size];

  const borderColor = error ? ERROR_BORDER : DEFAULT_BORDER;
  const focusClass = error ? '' : 'focus-within:border-[#180149]';
  const disabledClass = disabled ? DISABLED_CLASSES : '';

  return [
    'flex items-center w-full bg-white border-solid transition-colors',
    config.height,
    config.padding,
    config.borderRadius,
    config.borderWidth,
    borderColor,
    focusClass,
    disabledClass,
  ]
    .filter(Boolean)
    .join(' ');
}

export const INPUT_INNER_CLASSES =
  "bg-transparent border-none outline-none flex-1 font-['Lexend'] font-medium text-[#737373] placeholder:text-[#737373]/60 w-full";
