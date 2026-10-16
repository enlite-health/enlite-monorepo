/**
 * Saída do Gem: JSON válido + resumo legível (nessa ordem). Separa os dois sem logar nada. Puro.
 * JSON inválido (ou ausente) NÃO derruba: devolve `json: null, jsonInvalid: true` e o resumo legível que sobrar.
 */
export interface GemOutput {
  json: unknown | null;
  jsonInvalid: boolean;
  readable: string;
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i += 1;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const stripFences = (s: string): string => s.replace(/^\s*```[a-z]*\s*/i, '').replace(/^\s*```\s*/, '').trim();

export function splitGemOutput(raw: string): GemOutput {
  const text = raw.trim();
  const start = text.indexOf('{');
  if (start < 0) return { json: null, jsonInvalid: true, readable: stripFences(text) };
  const end = balancedEnd(text, start);
  if (end < 0) {
    // JSON truncado: o que vem depois da última cerca, se houver, é o legível.
    const fence = text.lastIndexOf('```');
    return { json: null, jsonInvalid: true, readable: fence > start ? stripFences(text.slice(fence + 3)) : '' };
  }
  const readable = stripFences(text.slice(end + 1));
  try {
    return { json: JSON.parse(text.slice(start, end + 1)), jsonInvalid: false, readable };
  } catch {
    return { json: null, jsonInvalid: true, readable };
  }
}

/** JSON -> linhas legíveis (`chave: valor`, listas com `-`), para o anexo do PDF. Sem texto cru de JSON. */
export function renderStructuredLines(value: unknown, indent = 0): string[] {
  const pad = '  '.repeat(indent);
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        out.push(`${pad}-`);
        out.push(...renderStructuredLines(item, indent + 1));
      } else out.push(`${pad}- ${scalar(item)}`);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        out.push(`${pad}${k}:${Array.isArray(v) && v.length === 0 ? ' (vacío)' : ''}`);
        if (!(Array.isArray(v) && v.length === 0)) out.push(...renderStructuredLines(v, indent + 1));
      } else out.push(`${pad}${k}: ${scalar(v)}`);
    }
  } else out.push(`${pad}${scalar(value)}`);
  return out;
}
const scalar = (v: unknown): string => (v === null || v === undefined ? '—' : String(v));
