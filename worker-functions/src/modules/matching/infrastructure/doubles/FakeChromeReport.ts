import {
  type ChromeProfileReport,
  type ChromeReportPort,
  type ForcedInstallPolicy,
} from '../../application/ports/ChromeReportPort';

/**
 * Dublê do relatório do Chrome (NODE_ENV=test ou ADMISSION_EXTERNALS=fake). Programável e com TODAS as chamadas registradas
 * (é o espião do "default de produção chama 0 vezes; o dublê disponível chama ≥ 1").
 *  - `setInstalled(emails)`: o que `findInstalledAppProfiles` devolve; `profileCount` (padrão = tamanho da lista) é o controle;
 *  - `setProfile(email, profile|null)`: o que `profiles` devolve por pessoa;
 *  - `policy`: o valor de `policies:resolve`; `failWith(err)`: toda chamada falha com ele.
 * Sem programação: ninguém instalado, nenhum perfil, política `applied`.
 */
export class FakeChromeReport implements ChromeReportPort {
  readonly calls: string[] = [];
  policy: ForcedInstallPolicy = 'applied';
  profileCount: number | null = null;
  private installed: string[] = [];
  private readonly profiles = new Map<string, ChromeProfileReport | null>();
  private failure: Error | null = null;

  setInstalled(emails: string[]): void {
    this.installed = emails.map((e) => e.toLowerCase());
  }

  setProfile(email: string, profile: ChromeProfileReport | null): void {
    this.profiles.set(email.toLowerCase(), profile);
  }

  failWith(err: Error | null): void {
    this.failure = err;
  }

  reset(): void {
    this.calls.length = 0;
    this.policy = 'applied';
    this.profileCount = null;
    this.installed = [];
    this.profiles.clear();
    this.failure = null;
  }

  async findInstalledEmails(): Promise<string[]> {
    this.calls.push('findInstalledEmails');
    if (this.failure) throw this.failure;
    return [...this.installed];
  }

  async getProfile(email: string): Promise<ChromeProfileReport | null> {
    this.calls.push('getProfile');
    if (this.failure) throw this.failure;
    return this.profiles.get(email.toLowerCase()) ?? null;
  }

  async countInstalledProfiles(): Promise<number> {
    this.calls.push('countInstalledProfiles');
    if (this.failure) throw this.failure;
    return this.profileCount ?? this.installed.length;
  }

  async resolveForcedInstall(): Promise<ForcedInstallPolicy> {
    this.calls.push('resolveForcedInstall');
    if (this.failure) throw this.failure;
    return this.policy;
  }
}
