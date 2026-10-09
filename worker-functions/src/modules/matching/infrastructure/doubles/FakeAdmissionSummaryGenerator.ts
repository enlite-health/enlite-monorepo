import { AdmissionSummaryError, type AdmissionSummaryPort } from '../../application/ports/AdmissionImportPorts';

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

  async generate(input: { transcript: string }): Promise<{ summary: string; promptVersion: string }> {
    this.received.push(input.transcript);
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    return { summary: this.summary, promptVersion: this.promptVersion };
  }

  reset(): void {
    this.received.length = 0;
    this.failWith = null;
    this.gate = null;
    this.summary = 'RESUMO-SINTETICO: ponto A; ponto B.';
  }
}
