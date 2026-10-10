/**
 * Preenchimento do prompt do Gem (Google Doc). Puro, sem I/O.
 * - `normalizeMarkdownEscapes`: o Doc pode vir com escapes de Markdown (`\_`, `\*`, `\\\_`) nas chaves do JSON. SÓ o prompt da
 *   admissão passa por aqui (o `GoogleDocsPromptProvider` é compartilhado com a vacante e não muda).
 * - `fillPrompt` troca `{{NOME}}`; `findUnfilled` devolve SÓ os NOMES que sobraram (nunca texto em volta).
 *   `{{...}}` (reticências, usado como prosa no cabeçalho do Doc) não é marcador: marcador é `{{[A-Z0-9_]+}}`.
 */
const MARKER = /\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g;

export function normalizeMarkdownEscapes(text: string): string {
  return text.replace(/\\+([_*\[\]#`~>|-])/g, '$1');
}

export function fillPrompt(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(MARKER, (whole, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole));
}

export function findUnfilled(text: string): string[] {
  return [...new Set([...text.matchAll(MARKER)].map((m) => m[1]))];
}

/** Cabeçalho de metadados que o Gem pede por transcrição. `informante_tipo` fica de fora: o Gem infere e marca `informante_inferido`. */
export function buildInterviewInput(meta: { entrevistaId?: string; fecha?: string }, transcript: string): string {
  const head = [meta.entrevistaId ? `entrevista_id=${meta.entrevistaId}` : null, meta.fecha ? `fecha=${meta.fecha}` : null].filter(Boolean);
  return head.length ? `${head.join('\n')}\n\ntranscripcion:\n${transcript}` : transcript;
}
