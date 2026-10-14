/**
 * spec 050 F28 — A28-3 (um caminho só) e A28-9 (tetos de linhas). Varre o código de produção.
 *  - o job de 1 min, o passo do resumo e o portão NÃO falam com cofre, Vertex, PDF nem documento: só a importação fala (0 usos; controle: a importação usa);
 *  - `AdmissionImportService.ts` não passa das 404 linhas da F27; os módulos novos e o job ≤ 400.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const APP = resolve(__dirname, '..');
const lerArquivo = (p: string): string => readFileSync(resolve(APP, p), 'utf8');
const linhas = (p: string): number => lerArquivo(p).split('\n').length - 1;
const PAGO = /putOnce|summary\.generate|renderAdmissionSummaryPdf|documents\.prepare|destination\.prepareSummary|StoreAdmissionSummaryDocument\b.*new|admission\.paid_call|\.paid_call/;

describe('F28 — um caminho de importação só', () => {
  it('CONTROLE POSITIVO: a importação usa cofre, Vertex, PDF e documento (o padrão enxerga)', () => {
    const servico = lerArquivo('AdmissionImportService.ts');
    for (const p of ['putOnce', 'summary.generate', 'renderAdmissionSummaryPdf', 'destination.prepareSummary', '.paid_call']) expect(servico).toContain(p);
  });

  it.each(['AdmissionLiveJob.ts', 'AdmissionFastSummaryStep.ts', 'AdmissionFastGate.ts', '../infrastructure/AdmissionFastSummaryRepository.ts'])('%s não repete nenhum passo pago', (arq) => {
    expect(lerArquivo(arq).split('\n').filter((l) => PAGO.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'))).toEqual([]);
  });

  it('A28-9: `AdmissionImportService.ts` ≤ 404 (o número da F27) e os arquivos novos e o job ≤ 400', () => {
    expect(linhas('AdmissionImportService.ts')).toBeLessThanOrEqual(404);
    for (const a of ['AdmissionLiveJob.ts', 'AdmissionFastSummaryStep.ts', 'AdmissionFastGate.ts', 'AdmissionTranscriptReader.ts', '../infrastructure/AdmissionFastSummaryRepository.ts']) {
      expect(linhas(a)).toBeLessThanOrEqual(400);
    }
    expect(linhas('../../../index.ts')).toBeGreaterThan(400); // controle: a contagem enxerga um arquivo grande
  });
});
