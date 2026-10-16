import { validSummaryJson } from './admissionSummaryFixtures';
import { AdmissionSummaryError, type AdmissionSummaryInput, type AdmissionSummaryPort, type AdmissionSummaryResult, type SummaryConvocado } from '../../application/ports/AdmissionImportPorts';

/**
 * Dublê do Vertex. Registra o que recebeu (o teste prova que a transcrição só vai para ELE) e devolve um resumo SINTÉTICO
 * programável. `gate` segura a chamada (prova de execuções sobrepostas).
 */
export class FakeAdmissionSummaryGenerator implements AdmissionSummaryPort {
  readonly received: string[] = [];
  summary = 'RESUMO-SINTETICO: ponto A; ponto B.';
  promptVersion = 'fake-v0';
  failWith: AdmissionSummaryError | null = null;
  gate: Promise<void> | null = null;
  structured: unknown | null;
  jsonInvalid = false;
  readonly inputs: Array<{ entrevistaId?: string; fecha?: string; convocados?: readonly SummaryConvocado[] }> = [];

  /**
   * `options`: a instância do ENQUADRE (spec 052) tem outro esquema — `structured` fabrica o JSON válido e `assertShape` é o gate dela.
   * Sem opções, é o dublê da admissão (o serviço cai no gate da admissão).
   */
  constructor(private readonly options: { structured?: () => unknown; assertShape?: AdmissionSummaryPort['assertShape'] } = {}) {
    this.structured = (options.structured ?? validSummaryJson)();
    this.assertShape = options.assertShape;
  }

  readonly assertShape?: AdmissionSummaryPort['assertShape'];

  async generate(input: AdmissionSummaryInput): Promise<AdmissionSummaryResult> {
    this.received.push(input.transcript);
    this.inputs.push({ entrevistaId: input.entrevistaId, fecha: input.fecha, ...(input.convocados ? { convocados: input.convocados } : {}) });
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    return { summary: this.summary, promptVersion: this.promptVersion, structured: this.structured, jsonInvalid: this.jsonInvalid };
  }

  reset(): void {
    this.received.length = 0;
    this.failWith = null;
    this.gate = null;
    this.structured = (this.options.structured ?? validSummaryJson)();
    this.jsonInvalid = false;
    this.inputs.length = 0;
    this.summary = 'RESUMO-SINTETICO: ponto A; ponto B.';
  }
}
