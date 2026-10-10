import { AdmissionSummaryError, type AdmissionSummaryPort, type AdmissionSummaryResult } from '../../application/ports/AdmissionImportPorts';

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
  structured: unknown | null = null;
  jsonInvalid = false;
  readonly inputs: Array<{ entrevistaId?: string; fecha?: string }> = [];

  async generate(input: { transcript: string; entrevistaId?: string; fecha?: string }): Promise<AdmissionSummaryResult> {
    this.received.push(input.transcript);
    this.inputs.push({ entrevistaId: input.entrevistaId, fecha: input.fecha });
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    return { summary: this.summary, promptVersion: this.promptVersion, structured: this.structured, jsonInvalid: this.jsonInvalid };
  }

  reset(): void {
    this.received.length = 0;
    this.failWith = null;
    this.gate = null;
    this.structured = null;
    this.jsonInvalid = false;
    this.inputs.length = 0;
    this.summary = 'RESUMO-SINTETICO: ponto A; ponto B.';
  }
}
