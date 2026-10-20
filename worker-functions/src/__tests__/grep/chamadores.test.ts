/**
 * Grep-teste T081-(2) (spec 058, Rv29): quem pode CHAMAR as funções de leitura/projeção. Uma segunda rota que leia o pagador/preço
 * "do seu jeito" reabre a divergência ficha x rota (D-44) ou vaza o preço sem passar pela redação (§0).
 * Escopo: fontes de `src` não-teste, sem comentários. Cada símbolo tem o conjunto fechado de arquivos que podem citá-lo (definição incluída).
 * Nota: a spec fala em `fetchContractedServiceChildren` e `decorate`; no código real eles moram em ContractedServiceDetailMapper.ts (ficha) e
 * PatientContractedServiceRepository.ts (rota). A granularidade do teste é o ARQUIVO.
 * Desvio da spec (declarado na Lista da rodada 6): `projectContractedServiceForActor` tem um 3º chamador legítimo, o controller do vínculo
 * (AdminContractedServiceContractLinkController, T060), que devolve o serviço inteiro projetado.
 */
import { fontesSrc, ler, semComentarios } from './helpers058a';

const C = 'modules/case';
const MAPPER = `${C}/infrastructure/ContractedServiceDetailMapper.ts`;
const REPO_SVC = `${C}/infrastructure/PatientContractedServiceRepository.ts`;
const PAYER_READ = `${C}/infrastructure/contractedServicePayerRead.ts`;
const PRICE_READ = `${C}/infrastructure/contractedServicePriceRead.ts`;
const TERM_READ = `${C}/infrastructure/insuranceContractTermRead.ts`;
const ACCESS = `${C}/application/contractedServiceHourlyValueAccess.ts`;
const CONTRACTS_CTRL = `${C}/interfaces/controllers/AdminInsuranceContractsController.ts`;
const LINK_CTRL = `${C}/interfaces/controllers/AdminContractedServiceContractLinkController.ts`;
const PATIENT_SVC_CTRL = `${C}/interfaces/controllers/AdminPatientContractedServicesController.ts`;
const PATIENT_VIEW = `${C}/interfaces/AdminPatientView.ts`;

/** símbolo -> arquivos permitidos (definição + chamadores). */
const PERMITIDOS: Record<string, string[]> = {
  payerAtMany: [PAYER_READ, MAPPER, REPO_SVC],
  payerHistoryMany: [PAYER_READ, MAPPER, REPO_SVC],
  priceStateMany: [PRICE_READ, MAPPER, REPO_SVC],
  derivePayerCoverageMatch: [PAYER_READ, MAPPER, REPO_SVC],
  termView: [TERM_READ, PRICE_READ, CONTRACTS_CTRL],
  redactTermForActor: [ACCESS, CONTRACTS_CTRL],
  projectContractedServiceForActor: [ACCESS, PATIENT_VIEW, PATIENT_SVC_CTRL, LINK_CTRL],
};

function usos(simbolo: string, arquivos: Record<string, string>): string[] {
  const re = new RegExp(`\\b${simbolo}\\b`);
  return Object.keys(arquivos)
    .filter((f) => re.test(semComentarios(arquivos[f])))
    .sort();
}

describe('grep-teste Rv29: chamadores das leituras e da projeção', () => {
  const todos = fontesSrc();
  const conteudo: Record<string, string> = Object.fromEntries(todos.map((f) => [f, ler(f)]));

  it('o scanner enxerga src e os arquivos-dono (contagem zero seria "não medi")', () => {
    expect(todos.length).toBeGreaterThan(100);
    for (const [simbolo, permitidos] of Object.entries(PERMITIDOS)) {
      expect(usos(simbolo, conteudo).length).toBeGreaterThan(0);
      for (const dono of permitidos) expect(todos).toContain(dono);
    }
  });

  it('o detector acha um chamador plantado em memória e ignora comentário (controle positivo)', () => {
    const intruso = `${C}/interfaces/controllers/AdminInsuranceProvidersController.ts`;
    const plantado = { ...conteudo, [intruso]: "import { payerAtMany } from '../../infrastructure/contractedServicePayerRead';" };
    expect(usos('payerAtMany', plantado)).toContain(intruso);
    expect(usos('payerAtMany', { a: '// payerAtMany só em comentário\n/* payerAtMany */' })).toEqual([]);
  });

  it.each(Object.keys(PERMITIDOS))('%s só é citado pelos arquivos permitidos', (simbolo) => {
    const fora = usos(simbolo, conteudo).filter((f) => !PERMITIDOS[simbolo].includes(f));
    expect(fora).toEqual([]);
  });

  it.each(Object.keys(PERMITIDOS))('%s é de fato usado por cada arquivo permitido (a lista não envelhece sobrando nome)', (simbolo) => {
    const achados = usos(simbolo, conteudo);
    for (const f of PERMITIDOS[simbolo]) expect(achados).toContain(f);
  });
});
