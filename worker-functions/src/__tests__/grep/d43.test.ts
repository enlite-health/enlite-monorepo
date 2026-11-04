/**
 * Grep-teste T080-(1) (spec 058, D-43): nenhum "hoje" no SQL — `CURRENT_DATE`/`now()` — nos 16 arquivos da spec.
 * O "hoje" é o `asOf` calculado em TS por `operationDateOf(country, now)` e passado como parâmetro.
 * Exclusões citadas pela spec (§3.3 nota 2): `vacancyEffectiveFieldsSql.ts:68` e `vacancySourceChangeNotice.ts:91` — ficam FORA da lista.
 * Prova de que enxerga: os 16 arquivos existem e têm conteúdo; o padrão casa em amostras ruins; e casa num arquivo real excluído
 * (`vacancySourceChangeNotice.ts` tem `now()`), então um scanner cego não passaria.
 */
import { ler, semComentarios } from './helpers058a';

const C = 'modules/case';
export const D43_ARQUIVOS = [
  `${C}/infrastructure/insuranceContractTermRead.ts`,
  `${C}/infrastructure/contractedServicePayerRead.ts`,
  `${C}/infrastructure/contractedServicePriceRead.ts`,
  `${C}/infrastructure/providerPatientsRead.ts`,
  `${C}/infrastructure/contractedServiceContractLinkWriter.ts`,
  `${C}/infrastructure/insuranceContractTermWriter.ts`,
  `${C}/interfaces/controllers/AdminInsuranceContractsController.ts`,
  `${C}/infrastructure/InsuranceContractRepository.ts`,
  `${C}/infrastructure/InsuranceProviderContactRepository.ts`,
  `${C}/infrastructure/InsuranceProviderRepository.ts`,
  `${C}/interfaces/controllers/AdminContractedServiceContractLinkController.ts`,
  `${C}/infrastructure/contractedServiceAuthorizationRead.ts`,
  `${C}/infrastructure/ContractedServiceDetailMapper.ts`,
  `${C}/interfaces/controllers/AdminPatientContractedServicesController.ts`,
  `${C}/infrastructure/PatientDetailQueryHelper.ts`,
  `${C}/infrastructure/PatientContractedServiceRepository.ts`,
];
const EXCLUIDOS = [`${C}/infrastructure/vacancySourceChangeNotice.ts`, 'shared/sql/vacancyEffectiveFieldsSql.ts'];
const HOJE_NO_SQL = /\bCURRENT_DATE\b|\bnow\s*\(\s*\)/i;
// Regra restrita (só o "hoje" de VIGÊNCIA): o repositório carimba `ended_at = NOW()`/`updated_at = NOW()` e o controller usa `this.now()` (relógio injetado em TS).
const SO_VIGENCIA = [`${C}/infrastructure/PatientContractedServiceRepository.ts`, `${C}/interfaces/controllers/AdminPatientContractedServicesController.ts`];
const HOJE_DE_VIGENCIA = /\bCURRENT_DATE\b|\bnow\s*\(\s*\)\s*::\s*date\b/i;

describe('grep-teste D-43: sem CURRENT_DATE/now() nos 16 arquivos da spec 058', () => {
  it('são 16 arquivos, todos lidos e não vazios (contagem zero seria "não medi")', () => {
    expect(D43_ARQUIVOS).toHaveLength(16);
    for (const f of D43_ARQUIVOS) expect(ler(f).length).toBeGreaterThan(200);
  });

  it('o padrão casa nas amostras ruins (controle positivo)', () => {
    for (const ruim of ['WHERE x = CURRENT_DATE', 'SET a = now()', 'current_date', 'NOW( )']) expect(HOJE_NO_SQL.test(ruim)).toBe(true);
    expect(HOJE_NO_SQL.test('operationDateOf(country, now)')).toBe(false);
  });

  it('o scanner enxerga um arquivo real que tem now() (o excluído vacancySourceChangeNotice.ts)', () => {
    expect(HOJE_NO_SQL.test(semComentarios(ler(EXCLUIDOS[0])))).toBe(true);
  });

  it('a regra restrita casa o "hoje" de vigência e deixa passar o carimbo NOW()', () => {
    for (const ruim of ['valid @> CURRENT_DATE', 'now()::date', 'NOW( )::date']) expect(HOJE_DE_VIGENCIA.test(ruim)).toBe(true);
    expect(HOJE_DE_VIGENCIA.test('ended_at = NOW()')).toBe(false);
  });

  it.each(SO_VIGENCIA)('%s: o scanner vê o NOW()/this.now() real e a regra restrita o aceita de propósito', (arquivo) => {
    const sql = semComentarios(ler(arquivo));
    expect(HOJE_NO_SQL.test(sql)).toBe(true);
    expect(HOJE_DE_VIGENCIA.test(sql)).toBe(false);
  });

  it.each(D43_ARQUIVOS)('%s não tem CURRENT_DATE nem now()', (arquivo) => {
    const re = SO_VIGENCIA.includes(arquivo) ? HOJE_DE_VIGENCIA : HOJE_NO_SQL;
    const linhas = semComentarios(ler(arquivo)).split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => re.test(l));
    expect(linhas).toEqual([]);
  });
});
