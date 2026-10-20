/**
 * Grep-testes T082 e T083 (spec 058 Parte A).
 *  (3) T082: arquivos novos não citam as 6 colunas legadas (fronteira de palavra: `patient_insurance_verified` NÃO é `insurance_verified`).
 *  (4) T083-4: `legacy_discard` (GUC app.legacy_discard) só em `migrations/` e `scripts/` — nunca em `src`.
 *  (5) T083-5 front: nenhum `new Date()` p/ "hoje" nos arquivos novos de A e nenhum `page.route` em e2e novo. (A1 não tem arquivo novo de front:
 *      passa vazio, MAS os detectores são provados com amostra plantada em memória; os nomes de arquivo são os da A2.)
 *  (6) T083-6 FR-26: arquivos novos de A não citam `approved_hours`/`montante` (isso é Parte B).
 */
import * as fs from 'fs';
import * as path from 'path';
import { ler, NOVOS_A1_SRC, REPO, semComentarios, WF } from './helpers058a';

const LEGADO = /(?<![a-z_])(hourly_value|tax_condition|contract_type|insurance_verified|health_insurance_name|health_insurance_member_id)(?![a-z_])/;
const FR26 = /approved_hours|montante/i;
const LEGACY_DISCARD = /legacy_discard/;
const NEW_DATE_HOJE = /new Date\(\s*\)/;
const PAGE_ROUTE = /\bpage\.route\s*\(/;

function lista(dir: string, aceita: (arquivo: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) lista(full, aceita, out);
    else if (aceita(full)) out.push(full);
  }
  return out;
}

describe('grep-teste T082: arquivos novos não citam as 6 colunas legadas', () => {
  it('são os arquivos novos, todos existem (contagem zero seria "não medi")', () => {
    expect(NOVOS_A1_SRC.length).toBeGreaterThanOrEqual(25);
    for (const f of NOVOS_A1_SRC) expect(ler(f).length).toBeGreaterThan(50);
  });

  it('o padrão casa nas 6 colunas, e NÃO casa em patient_insurance_verified (controle positivo e de fronteira)', () => {
    for (const col of ['hourly_value', 'tax_condition', 'contract_type', 'insurance_verified', 'health_insurance_name', 'health_insurance_member_id']) {
      expect(LEGADO.test(`SELECT p.${col} FROM x`)).toBe(true);
    }
    expect(LEGADO.test('FROM patient_insurance_verified piv')).toBe(false);
  });

  it('o scanner acha as colunas num arquivo real que as usa de propósito (script histórico de reconciliação)', () => {
    const script = fs.readFileSync(path.join(WF, 'scripts/relatorio-conflitos-p2a.ts'), 'utf8');
    expect(LEGADO.test(script)).toBe(true);
  });

  it.each(NOVOS_A1_SRC)('%s não cita coluna legada', (arquivo) => {
    const linhas = semComentarios(ler(arquivo)).split('\n').filter((l) => LEGADO.test(l));
    expect(linhas).toEqual([]);
  });
});

describe('grep-teste T083-4: legacy_discard só em migrations/ e scripts/', () => {
  it('nenhuma fonte de src (testes inclusive, menos este arquivo) cita legacy_discard', () => {
    const todas = lista(path.join(WF, 'src'), (f) => /\.ts$/.test(f));
    expect(todas.length).toBeGreaterThan(300);
    const este = path.join('__tests__', 'grep', 'legado.test.ts');
    const achados = todas.filter((f) => !f.endsWith(este)).filter((f) => LEGACY_DISCARD.test(fs.readFileSync(f, 'utf8')));
    expect(achados.map((f) => path.relative(WF, f))).toEqual([]);
  });

  it('o detector enxerga: casa em amostra e o MESMO varredor acha um GUC vizinho que existe em migrations/ (legacy_discard ainda não existe: P1b)', () => {
    expect(LEGACY_DISCARD.test("SET LOCAL app.legacy_discard = 'on'")).toBe(true);
    const migs = lista(path.join(WF, 'migrations'), (f) => /\.sql$/.test(f));
    expect(migs.length).toBeGreaterThan(400);
    // controle: o varredor de arquivos de migrations/ acha um termo que EXISTE lá (medido: git grep system_context = muitas), logo "0 legacy_discard" é medido
    const vizinho = /app\.current_uid/;
    expect(migs.filter((f) => vizinho.test(fs.readFileSync(f, 'utf8'))).length).toBeGreaterThan(3);
  });
});

describe('grep-teste T083-5: front — sem new Date() de "hoje" nos arquivos novos de A, sem page.route em e2e novo', () => {
  const FRONT_SRC = path.join(REPO, 'enlite-frontend/src');
  const FRONT_E2E = path.join(REPO, 'enlite-frontend/e2e');
  const novosFront = () =>
    lista(
      FRONT_SRC,
      (f) =>
        /(AdminInsuranceApiService|InsuranceProviderDetail|InsuranceProvidersPage|InsuranceContract|ContractTermForm)/.test(path.basename(f)) &&
        /\.tsx?$/.test(f) &&
        !/\.test\./.test(f),
    );
  const novosE2e = () => lista(FRONT_E2E, (f) => /058a|insurance-provider|insurance-contract/.test(path.basename(f)) && /\.ts$/.test(f));

  it('o front é alcançável (src e e2e existem; senão 0 arquivos seria "não medi")', () => {
    expect(fs.existsSync(FRONT_SRC)).toBe(true);
    expect(fs.existsSync(FRONT_E2E)).toBe(true);
    expect(lista(FRONT_SRC, (f) => /\.tsx?$/.test(f)).length).toBeGreaterThan(500);
  });

  it('os detectores casam em amostra plantada em memória (controle positivo)', () => {
    expect(NEW_DATE_HOJE.test('const hoje = new Date();')).toBe(true);
    expect(NEW_DATE_HOJE.test('new Date(iso)')).toBe(false);
    expect(PAGE_ROUTE.test("await page.route('**/api/**', (r) => r.fulfill())")).toBe(true);
  });

  it('nenhum arquivo novo de front de A usa new Date() para "hoje"', () => {
    const achados = novosFront().filter((f) => NEW_DATE_HOJE.test(semComentarios(fs.readFileSync(f, 'utf8'))));
    expect(achados).toEqual([]);
  });

  it('nenhum e2e novo de A usa page.route', () => {
    const achados = novosE2e().filter((f) => PAGE_ROUTE.test(semComentarios(fs.readFileSync(f, 'utf8'))));
    expect(achados).toEqual([]);
  });
});

describe('grep-teste T083-6 FR-26: arquivos novos de A não citam approved_hours/montante', () => {
  it('o padrão casa na amostra (controle positivo)', () => {
    expect(FR26.test('SELECT approved_hours FROM x')).toBe(true);
    expect(FR26.test('Montante')).toBe(true);
  });

  it.each(NOVOS_A1_SRC)('%s não cita approved_hours/montante (FR-26)', (arquivo) => {
    const linhas = semComentarios(ler(arquivo)).split('\n').filter((l) => FR26.test(l));
    expect(linhas).toEqual([]);
  });
});
