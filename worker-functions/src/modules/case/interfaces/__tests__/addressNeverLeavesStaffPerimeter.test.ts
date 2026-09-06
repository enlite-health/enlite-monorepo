/**
 * lex C2.2 / C2.5 (spec 012, US-B2) — o endereço exato e as notas de acesso do domicílio NÃO saem
 * do perímetro do staff:
 *   - nenhuma rota/controller/mapper PÚBLICO ou de PRESTADOR projeta `access_notes`,
 *     `logistics_corridor`, `address_formatted`, `lat`/`lng` de `patient_addresses`;
 *   - `access_notes` não passa por `patient_field_overrides_audit` (vacancyCrudAuditHelpers),
 *     que copia old/new em claro para uma tabela com grant de tabela inteira.
 * É um teste de FONTE (varre o código), porque a superfície pública é um conjunto de arquivos e
 * o modo de falha é alguém acrescentar a coluna a um SELECT — o grep é o que pega isso.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Superfície pública/prestador: tudo que tem "public" ou "worker" (portal do prestador) no caminho das interfaces. */
function publicSurface(): string[] {
  return walk(SRC).filter((p) => /\/interfaces\//.test(p) && /public|Public|worker\/interfaces|WorkerPortal|jobs/.test(p) && !/admin|Admin/.test(p));
}

describe('endereço do paciente não sai do perímetro do staff (lex C2.2/C2.5)', () => {
  it('a superfície pública/prestador existe (contagem > 0 — senão o teste não olhou nada)', () => {
    expect(publicSurface().length).toBeGreaterThan(0);
  });

  it.each(['access_notes', 'accessNotes', 'logistics_corridor', 'logisticsCorridor'])('%s: 0 ocorrências fora de case/matching-admin', (needle) => {
    const hits = walk(SRC).filter((p) => fs.readFileSync(p, 'utf8').includes(needle))
      .filter((p) => !/\/modules\/case\//.test(p))
      // a deny-list do SQL ad-hoc NOMEIA a coluna para negá-la — é o oposto de projetar.
      .filter((p) => !p.endsWith('modules/mcp/application/ReadonlyDbQueryService.ts'));
    expect(hits).toEqual([]);
  });

  it('address_formatted / lat / lng de patient_addresses: nenhum arquivo da superfície pública os projeta', () => {
    const offenders = publicSurface().filter((p) => {
      const s = fs.readFileSync(p, 'utf8');
      return /patient_addresses/.test(s) && /address_formatted|\bpa\.lat\b|\bpa\.lng\b|address_raw/.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it('access_notes não entra na trilha patient_field_overrides_audit (vacancyCrudAuditHelpers)', () => {
    const helper = fs.readFileSync(path.join(SRC, 'modules/matching/interfaces/controllers/vacancyCrudAuditHelpers.ts'), 'utf8');
    expect(helper).toContain('patient_field_overrides_audit');
    expect(helper).not.toMatch(/access_notes|accessNotes/);
  });
});
