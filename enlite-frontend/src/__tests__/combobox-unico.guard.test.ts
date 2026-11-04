// Guardas da spec 070 (FR-13): leem o código-fonte e reprovam a volta do defeito
// "vários combos diferentes". Se uma falha, não relaxe a guarda: use o `Combobox`.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');
const THIS = relative(SRC, __filename);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

// Comentários não contam (citam `<select>` e nomes antigos de propósito). Tira `/* */`, `{/* */}` e `//` de linha.
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{(])\/\/.*$/gm, '$1');
}

const files = walk(SRC)
  .map((f) => ({ rel: relative(SRC, f), full: f }))
  .filter((f) => /\.(ts|tsx)$/.test(f.rel) && f.rel !== THIS);
const prod = files.filter((f) => !/\.test\.tsx?$/.test(f.rel) && !f.rel.includes('__tests__'));

function offenders(list: typeof files, re: RegExp, except: string[] = []): string[] {
  return list
    .filter((f) => !except.includes(f.rel))
    .filter((f) => re.test(stripComments(readFileSync(f.full, 'utf8'))))
    .map((f) => f.rel);
}

describe('combobox único (spec 070, FR-13)', () => {
  it('(a) 0 <select> JSX fora de TablePagination e PatientStatusControl', () => {
    // Exclusões declaradas na spec §5. Os 4 pickers de servidor (D545: IcdSearchCombobox,
    // CandidateAutocomplete, WorkerTagMultiSelect, InterviewHostPanel) não usam <select> e ficam fora de escopo.
    const except = [
      'presentation/components/molecules/TablePagination/TablePagination.tsx',
      'presentation/components/features/admin/PatientDetail/PatientStatusControl.tsx',
    ];
    expect(offenders(prod, /<select[\s>]/, except)).toEqual([]);
  });

  it("(b) 0 normalize('NFD') fora de utils/normalizeText.ts", () => {
    expect(
      offenders(prod, /normalize\(\s*['"]NFD['"]\s*\)/, ['presentation/utils/normalizeText.ts']),
    ).toEqual([]);
  });

  it('(c) 0 importação ou uso dos componentes removidos', () => {
    const removedPath =
      /from\s+['"][^'"]*\/(Select|SelectField|MultiSelect|SearchableSelect|ProviderFilterCombobox)['"]/;
    const removedName = /\b(SelectField|SearchableSelect|ProviderFilterCombobox|SelectOption)\b/;
    // `MultiSelect` sozinho (os pickers WorkerTagMultiSelect etc. não casam por causa do \b).
    const removedMulti = /\bMultiSelect\b/;
    expect(offenders(files, removedPath)).toEqual([]);
    expect(offenders(files, removedName)).toEqual([]);
    expect(offenders(files, removedMulti)).toEqual([]);
  });

  it('(d) o gatilho do Combobox tem role="combobox" e SEARCH_MIN_OPTIONS tem uma só fonte', () => {
    const combobox = readFileSync(
      join(SRC, 'presentation/components/atoms/Combobox/Combobox.tsx'),
      'utf8',
    );
    expect(combobox).toMatch(/role="combobox"/);
    expect(combobox).toMatch(/export const SEARCH_MIN_OPTIONS\s*=/);
    expect(offenders(prod, /\bconst\s+SEARCH_MIN_OPTIONS\s*=/)).toEqual([
      'presentation/components/atoms/Combobox/Combobox.tsx',
    ]);
  });
});
