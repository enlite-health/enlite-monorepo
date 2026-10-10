import {
  MeetScopeMissingError,
  MeetTransientError,
  type MeetConferencePort,
  type MeetConferenceRecord,
} from '../../application/ports/MeetConferencePort';

/**
 * Dublê da Meet API (NODE_ENV=test ou ADMISSION_EXTERNALS=fake). Programável por código do Meet:
 *  - sem programação, o espaço existe e NÃO tem conferência (ninguém entrou);
 *  - `setRecords(code, [...])` → as conferências do espaço; `failWith(err)` → toda chamada falha com ele;
 *  - `delayMs` segura cada chamada (prova de execuções sobrepostas).
 */
export class FakeMeetConference implements MeetConferencePort {
  readonly resolveCalls: string[] = [];
  readonly listCalls: string[] = [];
  delayMs = 0;
  private readonly records = new Map<string, MeetConferenceRecord[]>();
  private failure: Error | null = null;

  setRecords(meetCode: string, records: MeetConferenceRecord[]): void {
    this.records.set(`spaces/${meetCode}`, records);
  }

  /** Esquece o programado e as chamadas (entre testes). */
  reset(): void {
    this.records.clear();
    this.failure = null;
    this.delayMs = 0;
    this.resolveCalls.length = 0;
    this.listCalls.length = 0;
  }

  failWith(err: Error | null): void {
    this.failure = err;
  }

  scopeMissing(): void {
    this.failure = new MeetScopeMissingError();
  }

  transient(reason = 'network'): void {
    this.failure = new MeetTransientError(reason);
  }

  async resolveSpace(meetCode: string): Promise<{ spaceName: string }> {
    this.resolveCalls.push(meetCode);
    await this.wait();
    if (this.failure) throw this.failure;
    return { spaceName: `spaces/${meetCode}` };
  }

  async listConferenceRecords(spaceName: string): Promise<MeetConferenceRecord[]> {
    this.listCalls.push(spaceName);
    await this.wait();
    if (this.failure) throw this.failure;
    return [...(this.records.get(spaceName) ?? [])];
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }
}
