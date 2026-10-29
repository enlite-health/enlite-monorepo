import { Fragment, Slice, type ResolvedPos } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

/**
 * `clipboardTextParser` do compositor: texto colado vira UM parágrafo com `hardBreak` entre as
 * linhas (linhas em branco preservadas). O padrão do ProseMirror cria um parágrafo por linha e o
 * `getText()` junta parágrafos com "\n\n", o que quebrava tabela e lista de markdown colada.
 */
export function pastePlainTextAsHardBreaks(text: string, $context: ResolvedPos, _plain: boolean, view: EditorView): Slice {
  const { schema } = view.state;
  const marks = $context.marks();
  const nodes = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line, i) => [
      ...(i > 0 ? [schema.nodes.hardBreak.create()] : []),
      ...(line ? [schema.text(line, marks)] : []),
    ]);
  return new Slice(Fragment.from(schema.nodes.paragraph.create(null, nodes)), 1, 1);
}
