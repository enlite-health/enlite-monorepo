const FENCE = /^(```|~~~)/;
const DELIMITER = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

const isBlank = (line: string): boolean => line.trim() === '';
const isTableLine = (line: string): boolean => line.trim().startsWith('|');

/**
 * Em GFM uma linha em branco encerra a tabela; quem cola uma tabela "com respiro" entre as linhas
 * vê texto cru. Na exibição (o texto gravado não muda), remove as linhas em branco entre linhas de
 * tabela, SÓ se o grupo tem linha delimitadora (`|---|`, `:---`, `---:`, `:---:`). Blocos
 * cercados (``` ou ~~~) ficam intactos.
 */
export function normalizeLooseTables(body: string): string {
  if (!body.includes('|')) return body;
  const lines = body.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const mark = FENCE.exec(line.trim())?.[1];
    if (fence !== null) {
      if (mark === fence) fence = null;
      out.push(line);
      i += 1;
    } else if (mark) {
      fence = mark;
      out.push(line);
      i += 1;
    } else if (isTableLine(line)) {
      let last = i;
      let next = i + 1;
      for (;;) {
        while (next < lines.length && isBlank(lines[next])) next += 1;
        if (next >= lines.length || !isTableLine(lines[next])) break;
        last = next;
        next += 1;
      }
      const group = lines.slice(i, last + 1);
      const isTable = group.some((l) => DELIMITER.test(l.trim()));
      out.push(...(isTable ? group.filter((l) => !isBlank(l)) : group));
      i = last + 1;
    } else {
      out.push(line);
      i += 1;
    }
  }
  return out.join('\n');
}
