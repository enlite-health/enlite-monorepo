// Fonte única de verdade visual para botões — e para o que PARECE botão sem ser.
//
// 🔒 POR QUE ESTE ARQUIVO EXISTE, e não só o componente.
//
// Metade das ações destas telas não é `<button>`: "Duplicar y corregir",
// "Ver el detalle en Twilio" e "＋ Crear versión" são NAVEGAÇÃO — `<Link>` e
// `<a>` — e trocá-los por `<button>` com `navigate()` custaria o clique do meio,
// o "abrir em nova aba" e o endereço no status bar do navegador.
//
// Enquanto as classes viviam só dentro do componente, esses elementos eram
// estilizados à mão e derivavam: um com `px-4 py-2.5`, outro com `px-3.5 py-1.5`,
// e o texto ora em 14px ora em 12px. Exportar os tokens é o que faz "parece um
// botão" e "é um botão" terem o MESMO tamanho — o mesmo padrão que
// `inputClasses.ts` já usa para input, textarea e select.

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'compact' | 'sm' | 'md' | 'lg';

/**
 * Tokens de tamanho.
 *
 * `sm`/`md`/`lg` são os canônicos do Figma e NÃO mudaram — 618 chamadas no
 * repositório dependem deles.
 *
 * 🔒 `compact` NÃO vem do Figma, e isto está dito de propósito: ele vem do
 * desenho "Registro de Plantillas" (31/08/2026), cujo `.s-btn` é
 * `padding: 8px 18px; font-size: 13px; font-weight: 500`. O menor tamanho que
 * existia (`sm`) é 32px de altura com texto de 14px em peso 600 — e nas telas de
 * plantillas, que são densas, ele ainda lia como botão de CTA. Quando o Figma
 * absorver esta escala, este comentário sai.
 */
const SIZE: Record<ButtonSize, string> = {
  compact: 'h-[38px] px-[18px] py-2 text-[13px] font-medium leading-[1.5]',
  sm: 'h-8 px-4 text-sm font-semibold leading-[1.35]',
  md: 'h-10 px-6 text-base font-semibold leading-[1.35]',
  lg: 'h-12 px-8 text-base font-semibold leading-[1.35]',
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white border border-primary hover:bg-primary/90',
  /**
   * ⚠️ `bg-transparent`, e NÃO branco. Cheguei a trocar para `bg-white` porque o
   * `.s-btn.outline` da maquete é branco — e isso mudaria TODO botão outline do
   * app, em 99 arquivos, para agradar uma tela. Um teste de outra tela
   * (`ReemplazosButton`) pegou. A diferença de fundo fica como falha declarada
   * do pixel-loop, que é onde ela pertence: não vale reescrever o sistema
   * inteiro por 1 propriedade em 171.
   */
  outline: 'bg-transparent text-primary border-2 border-primary hover:bg-primary/5',
  ghost: 'bg-transparent text-primary border-0 hover:bg-primary/5',
  /**
   * 🔒 `danger` é para o ato IRREVERSÍVEL, não para "apagar" em geral. Hoje tem
   * um consumidor só: "Enviar a Meta", onde o nome do template fica queimado na
   * conta de WhatsApp para sempre, mesmo se a Meta recusar. A cor é a do desenho
   * (`.s-btn.danger`, #C8117F) e ainda não está na paleta do Tailwind — quando
   * um segundo consumidor aparecer, ela vira token nomeado no `tailwind.config`.
   *
   * ⚠️ Deliberadamente NÃO é vermelho de erro: erro é algo que deu errado; isto
   * é algo que vai dar certo e não tem volta.
   */
  danger: 'bg-[#C8117F] text-white border border-[#C8117F] hover:bg-[#C8117F]/90',
};

/**
 * ⚠️ O PESO SAIU DAQUI e virou token de tamanho.
 *
 * Ele era `font-semibold` fixo no base. Com `compact` pedindo peso 500, um
 * `font-medium` acrescentado por fora colidiria com o `font-semibold` do base —
 * duas utilitárias de `font-weight` na mesma classe, e quem vence depende da
 * ordem em que o Tailwind as emite, não da ordem em que eu as escrevo. Um
 * peso por tamanho elimina a disputa. `sm`/`md`/`lg` seguem em 600.
 */
const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full overflow-hidden ' +
  'font-poppins tracking-normal text-center ' +
  'transition-colors duration-200 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50';

export interface ButtonClassesOpts {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export function buttonClasses({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
}: ButtonClassesOpts = {}): string {
  return [BASE, SIZE[size], VARIANT[variant], fullWidth ? 'w-full' : '']
    .filter(Boolean)
    .join(' ');
}
