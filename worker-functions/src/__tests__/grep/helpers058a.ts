/** Utilitários dos grep-testes da spec 058 Parte A (T080-T083). Não é um teste (não casa `*.test.ts`). */
import * as fs from 'fs';
import * as path from 'path';

export const SRC = path.resolve(__dirname, '../..');
export const WF = path.resolve(SRC, '..');
export const REPO = path.resolve(WF, '..');

const C = 'modules/case';

/** Arquivos NOVOS (não-teste) da Parte A, relativos a `worker-functions/src`. Escopo de T082/T083/FR-26. */
export const NOVOS_A1_SRC = [
  `${C}/domain/currencyOf.ts`,
  `${C}/domain/dateRangeWire.ts`,
  `${C}/domain/rangeWriteErrors.ts`,
  `${C}/infrastructure/InsuranceContractRepository.ts`,
  `${C}/infrastructure/InsuranceProviderContactRepository.ts`,
  `${C}/infrastructure/contractedServiceContractLinkWriter.ts`,
  `${C}/infrastructure/contractedServicePayerRead.ts`,
  `${C}/infrastructure/contractedServicePriceRead.ts`,
  `${C}/infrastructure/deriveProviderCode.ts`,
  `${C}/infrastructure/insuranceContractTermRead.ts`,
  `${C}/infrastructure/insuranceContractTermWriter.ts`,
  `${C}/infrastructure/patientCoverageRead.ts`,
  `${C}/infrastructure/providerPatientsRead.ts`,
  `${C}/interfaces/controllers/AdminContractedServiceContractLinkController.ts`,
  `${C}/interfaces/controllers/AdminInsuranceContractsController.ts`,
  `${C}/interfaces/controllers/AdminInsuranceProviderContactsController.ts`,
  `${C}/interfaces/controllers/insuranceErrorResponse.ts`,
  `${C}/interfaces/middleware/rejectLegacyKeys.ts`,
  `${C}/interfaces/routes/adminInsuranceRoutes.ts`,
  `${C}/interfaces/validators/contractLinkSchemas.ts`,
  `${C}/interfaces/validators/insuranceContactSchemas.ts`,
  `${C}/interfaces/validators/insuranceContractSchemas.ts`,
  `${C}/interfaces/validators/insuranceProviderSchemas.ts`,
  'shared/database/withSerializationRetry.ts',
  'shared/locale/operationDate.ts',
];

// Remove comentarios de bloco e de linha (aproximacao suficiente: sem "//" dentro de string nestes arquivos).
export function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

export function ler(relSrc: string): string {
  return fs.readFileSync(path.join(SRC, relSrc), 'utf8');
}

/** Todas as fontes `.ts` não-teste de `src` (caminhos relativos a `src`). */
export function fontesSrc(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      fontesSrc(full, out);
    } else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(path.relative(SRC, full));
    }
  }
  return out;
}
