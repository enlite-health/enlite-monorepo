// Fonte única de verdade visual para inputs, textareas e selects.
// Para adicionar um novo tamanho: basta inserir uma nova entrada em INPUT_SIZE_CONFIG.

export type InputSize = 'default' | 'compact';

interface SizeConfig {
  height: string;
  padding: string;
  fontSize: string;
  lineHeight: string;
  borderRadius: string;
}

export const INPUT_SIZE_CONFIG: Record<InputSize, SizeConfig> = {
  default: {
    height: 'h-[60px]',
    padding: 'px-5 py-3',
    fontSize: 'text-[20px]',
    lineHeight: 'leading-[1.3]',
    borderRadius: 'rounded-[10px]',
  },
  compact: {
    height: 'h-[42px]',
    padding: 'px-3 py-2',
    fontSize: 'text-sm',
    lineHeight: 'leading-[1.3]',
    borderRadius: 'rounded-lg',
  },
};

const BASE_CLASSES =
  "w-full bg-white font-['Lexend'] font-medium text-[#737373] placeholder:text-[#737373]/60 focus:outline-none transition-colors border-solid";

const DEFAULT_BORDER = 'border-[#d9d9d9]';
const ERROR_BORDER = 'border-red-500';
const FOCUS_BORDER = 'focus:border-[#180149]';
const DEFAULT_BORDER_WIDTH = 'border-2';
const COMPACT_BORDER_WIDTH = 'border';
const DISABLED_CLASSES = 'bg-[#f3f4f6] cursor-not-allowed';

export interface InputClassesOpts {
  size?: InputSize;
  error?: boolean;
  disabled?: boolean;
  omitHeight?: boolean;
}

export function inputBaseClasses(opts: InputClassesOpts = {}): string {
  const { size = 'default', error = false, disabled = false, omitHeight = false } = opts;
  const config = INPUT_SIZE_CONFIG[size];

  const borderWidth = size === 'compact' ? COMPACT_BORDER_WIDTH : DEFAULT_BORDER_WIDTH;
  const borderColor = error ? ERROR_BORDER : DEFAULT_BORDER;
  const focusClass = error ? '' : FOCUS_BORDER;
  const disabledClass = disabled ? DISABLED_CLASSES : '';

  const height = omitHeight ? '' : config.height;

  return [
    BASE_CLASSES,
    height,
    config.padding,
    config.fontSize,
    config.lineHeight,
    config.borderRadius,
    borderWidth,
    borderColor,
    focusClass,
    disabledClass,
  ]
    .filter(Boolean)
    .join(' ');
}

export function textareaBaseClasses(opts: Omit<InputClassesOpts, 'omitHeight'> = {}): string {
  return inputBaseClasses({ ...opts, omitHeight: true });
}

export interface WrapperClassesOpts {
  size?: InputSize;
  error?: boolean;
  disabled?: boolean;
}

export function inputWrapperClasses(opts: WrapperClassesOpts = {}): string {
  const { size = 'default', error = false, disabled = false } = opts;
  const config = INPUT_SIZE_CONFIG[size];

  const borderWidth = size === 'compact' ? COMPACT_BORDER_WIDTH : DEFAULT_BORDER_WIDTH;
  const borderColor = error ? ERROR_BORDER : DEFAULT_BORDER;
  const focusClass = error ? '' : 'focus-within:border-[#180149]';
  const disabledClass = disabled ? DISABLED_CLASSES : '';

  return [
    'flex items-center w-full bg-white border-solid transition-colors',
    config.height,
    config.padding,
    config.borderRadius,
    borderWidth,
    borderColor,
    focusClass,
    disabledClass,
  ]
    .filter(Boolean)
    .join(' ');
}

export const INPUT_INNER_CLASSES =
  "bg-transparent border-none outline-none flex-1 font-['Lexend'] font-medium text-[#737373] placeholder:text-[#737373]/60 w-full";
