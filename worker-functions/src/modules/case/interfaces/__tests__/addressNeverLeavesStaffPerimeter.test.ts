/**
 * lex C2.2 / C2.5 (spec 012, US-B2) + spec 019 (D310 item c, B6) — o endereço exato, as notas de
 * acesso do domicílio e o TIPO de local por parentesco NÃO saem do perímetro do staff:
 *   - nenhuma rota/controller/mapper PÚBLICO ou de PRESTADOR projeta `access_notes`,
 *     `logistics_corridor`, `address_type`/`address_type_other`, `address_formatted`, `lat`/`lng`
 *     de `patient_addresses`;
 *   - `access_notes` não passa por `patient_field_overrides_audit` (vacancyCrudAuditHelpers),
 *     que copia old/new em claro para uma tabela com grant de tabela inteira.
 * É um teste de FONTE (varre o código), porque a superfície pública é um conjunto de arquivos e
 * o modo de falha é alguém acrescentar a coluna a um SELECT — o grep é o que pega isso.
 *
 * B6 (spec 019): a exceção genérica `!/\/modules\/case\//` foi substituída por uma lista NOMEADA
 * — cada arquivo com o motivo pelo qual a menção é legítima (escritor autorizado, leitor
 * staff-only, ou comentário explicando uma remoção). Qualquer arquivo FORA da lista que contenha
 * uma das strings falha o teste — inclusive um novo arquivo em `modules/case` que não tenha sido
 * adicionado aqui de propósito.
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

/**
 * Lista NOMEADA (B6) — cada entrada é o motivo pelo qual o arquivo pode mencionar
 * access_notes/logistics_corridor/address_type/address_type_other sem violar o perímetro.
 * Caminho relativo a `SRC` (repo `worker-functions/`), comparado por sufixo.
 */
const ALLOWED_FILES: Record<string, string> = {
  'src/modules/mcp/application/ReadonlyDbQueryService.ts':
    'deny-list do SQL ad-hoc NOMEIA a coluna para negá-la — é o oposto de projetar (spec 019 3.4).',
  'src/modules/case/interfaces/controllers/AdminPatientAddressesController.ts':
    'PATCH do painel — único escritor de VALOR autorizado para address_type/address_type_other depois da B4; escritor de access_notes/logistics_corridor desde a spec 012.',
  'src/modules/case/interfaces/controllers/AdminPatientsController.ts':
    'criação do painel (access_notes/logistics_corridor) — address_type saiu do schema de criação na spec 019 (B4), só o comentário/is_default ficou.',
  'src/modules/case/application/PatientRelatedWriter.ts':
    'Path 3 (import ClickUp) só LÊ/copia access_notes/logistics_corridor da linha arquivada para a nova — não fabrica valor; address_type NUNCA é escrito aqui depois da B4 (só comentário explicando a remoção).',
  'src/modules/case/infrastructure/PatientDetailQueryHelper.ts':
    'leitor para exibição no card do painel (ficha do paciente) — mesma superfície que já lê access_notes.',
  'src/modules/case/infrastructure/PatientQueryRows.ts':
    'tipos da projeção de detalhe do painel (PatientAddressDetail) — declaração, não exposição pública.',
  'src/modules/case/infrastructure/PatientAddressQueryHelper.ts':
    'leitor/criador do painel (POST/GET /api/admin/patients/:id/addresses) — staff-only.',
  'src/infrastructure/repositories/PatientRepository.ts':
    'shim deprecado (PatientAddress.addressType) — comentário explicando que a coluna deixou de ser escrita aqui (B4/B5).',
  'src/modules/matching/infrastructure/PatientAddressRepository.ts':
    'sync do ClickUp — comentário explicando a remoção do literal hardcoded "service" (B4).',
  'src/modules/matching/interfaces/controllers/VacancyAddressReviewController.ts':
    'revisão de endereço de vaga (staff-only) — comentário explicando a remoção do campo do schema/INSERT (B4).',
  'src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts':
    'mapper do ClickUp — comentário explicando que para de escrever addressType a partir da posição do slot (B4).',
  'src/modules/case/infrastructure/backfillPatientAddressLocation.ts':
    'backfill de geocoding (script staff, sem HTTP) — comentário explicando que addressType deixou de ser obrigatório (B4).',
  'src/shared/openapi/registrations/adminPatients.ts':
    'contrato OpenAPI do PATCH/POST /api/admin/patients — rotas staff-only (requireStaff); documentação do contrato, não exposição de dado.',
  'src/shared/openapi/registrations/adminVacancies.ts':
    'contrato OpenAPI de /api/admin/vacancies — staff-only; comentário explicando a remoção do campo (B4/B7).',
};

function isAllowed(absPath: string): string | null {
  const rel = path.relative(path.dirname(SRC), absPath).replace(/\\/g, '/');
  for (const suffix of Object.keys(ALLOWED_FILES)) {
    if (rel.endsWith(suffix)) return suffix;
  }
  return null;
}

describe('endereço do paciente não sai do perímetro do staff (lex C2.2/C2.5; spec 019 B6)', () => {
  it('a superfície pública/prestador existe (contagem > 0 — senão o teste não olhou nada)', () => {
    expect(publicSurface().length).toBeGreaterThan(0);
  });

  it.each(['access_notes', 'accessNotes', 'logistics_corridor', 'logisticsCorridor', 'address_type', 'addressType'])(
    '%s: 0 ocorrências fora da lista NOMEADA de arquivos permitidos',
    (needle) => {
      const offenders = walk(SRC)
        .filter((p) => fs.readFileSync(p, 'utf8').includes(needle))
        .filter((p) => isAllowed(p) === null);
      expect(offenders).toEqual([]);
    },
  );

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

  it('address_type_other também não entra na trilha patient_field_overrides_audit (spec 019, mesma régua de access_notes)', () => {
    const helper = fs.readFileSync(path.join(SRC, 'modules/matching/interfaces/controllers/vacancyCrudAuditHelpers.ts'), 'utf8');
    expect(helper).not.toMatch(/address_type_other/);
  });

  // Sabotagem 1 (B6): string em arquivo de modules/integration FORA da lista nomeada → o teste CAI.
  it('sabotagem: um arquivo de modules/integration fora da lista nomeada com a string faz o teste cair', () => {
    const sabotaged = path.join(SRC, 'modules/integration/__sabotage_perimeter__.ts');
    fs.writeFileSync(sabotaged, '// address_type sabotagem\nexport const x = 1;\n');
    try {
      const offenders = walk(SRC)
        .filter((p) => fs.readFileSync(p, 'utf8').includes('address_type'))
        .filter((p) => isAllowed(p) === null);
      expect(offenders).not.toEqual([]);
      expect(offenders.some((p) => p.endsWith('__sabotage_perimeter__.ts'))).toBe(true);
    } finally {
      fs.rmSync(sabotaged, { force: true });
    }
  });

  // Sabotagem 2 (B6): string em arquivo de modules/case que NÃO está na lista nomeada → o teste CAI.
  it('sabotagem: um arquivo NOVO de modules/case (não nomeado) com a string faz o teste cair', () => {
    const sabotaged = path.join(SRC, 'modules/case/__sabotage_perimeter__.ts');
    fs.writeFileSync(sabotaged, '// address_type sabotagem em arquivo novo de modules/case, nao nomeado\nexport const x = 1;\n');
    try {
      const offenders = walk(SRC)
        .filter((p) => fs.readFileSync(p, 'utf8').includes('address_type'))
        .filter((p) => isAllowed(p) === null);
      expect(offenders.some((p) => p.endsWith('__sabotage_perimeter__.ts'))).toBe(true);
    } finally {
      fs.rmSync(sabotaged, { force: true });
    }
  });
});
