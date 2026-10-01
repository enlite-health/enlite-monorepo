/**
 * mentionChip — como o chip de menção (`<@uid>` no valor enviado ao servidor, "@Nome" no visual)
 * é renderizado pelo `Mention` extension do TipTap. Extraído de `MessageComposer.tsx` (Rodada 2/
 * R2-F) para o módulo reusável de menção — sem mudança visual.
 *
 * 🔒 POR QUE `renderText` (não `renderHTML`) decide o texto que sai ao servidor: o valor que vai
 * ao backend usa `editor.getText()`, que o TipTap resolve via `schema.toText` — este é o ponto de
 * extensão correto (não um serializador de DOM escrito à mão).
 */
import type { MentionOptions } from '@tiptap/extension-mention';

export const mentionChipRenderText: MentionOptions['renderText'] = ({ node }) => `<@${node.attrs.id}>`;

export const mentionChipRenderHTML: MentionOptions['renderHTML'] = ({ node }) => [
  'span',
  {
    'data-testid': 'composer-mention-chip',
    'data-id': node.attrs.id,
    class: 'inline-block px-1.5 py-0.5 mx-0.5 rounded bg-primary/10 text-primary text-sm',
  },
  `@${node.attrs.label ?? node.attrs.id}`,
];
