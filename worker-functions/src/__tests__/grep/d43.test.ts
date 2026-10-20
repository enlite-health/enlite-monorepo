/**
 * Grep-teste T080-(1) (spec 058, D-43): nenhum "hoje" no SQL — `CURRENT_DATE`/`now()` — nos 11 arquivos da spec.
 * O "hoje" é o `asOf` calculado em TS por `operationDateOf(country, now)` e passado como parâmetro.
 * Exclusões citadas pela spec (§3.3 nota 2): `vacancyEffectiveFieldsSql.ts:68` e `vacancySourceChangeNotice.ts:91` — ficam FORA da lista.
 * Prova de que enxerga: os 11 arquivos existem e têm conteúdo; o padrão casa em amostras ruins; e casa num arquivo real excluído
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
];
const EXCLUIDOS = [`${C}/infrastructure/vacancySourceChangeNotice.ts`, 'shared/sql/vacancyEffectiveFieldsSql.ts'];
const HOJE_NO_SQL = /\bCURRENT_DATE\b|\bnow\s*\(\s*\)/i;

describe('grep-teste D-43: sem CURRENT_DATE/now() nos 11 arquivos da spec 058', () => {
  it('são 11 arquivos, todos lidos e não vazios (contagem zero seria "não medi")', () => {
    expect(D43_ARQUIVOS).toHaveLength(11);
    for (const f of D43_ARQUIVOS) expect(ler(f).length).toBeGreaterThan(200);
  });

  it('o padrão casa nas amostras ruins (controle positivo)', () => {
    for (const ruim of ['WHERE x = CURRENT_DATE', 'SET a = now()', 'current_date', 'NOW( )']) expect(HOJE_NO_SQL.test(ruim)).toBe(true);
    expect(HOJE_NO_SQL.test('operationDateOf(country, now)')).toBe(false);
  });

  it('o scanner enxerga um arquivo real que tem now() (o excluído vacancySourceChangeNotice.ts)', () => {
    expect(HOJE_NO_SQL.test(semComentarios(ler(EXCLUIDOS[0])))).toBe(true);
  });

  it.each(D43_ARQUIVOS)('%s não tem CURRENT_DATE nem now()', (arquivo) => {
    const linhas = semComentarios(ler(arquivo)).split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => HOJE_NO_SQL.test(l));
    expect(linhas).toEqual([]);
  });
});
