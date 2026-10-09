import {
  TactiqInvalidGrantError,
  type TactiqMcpPort,
  type TactiqMeetingItem,
  type TactiqOAuthPort,
  type TactiqTokenSet,
  type TactiqTranscriptPage,
} from '../../application/ports/TactiqPorts';

/**
 * Dublê do OAuth do Tactiq (NODE_ENV=test ou ADMISSION_EXTERNALS=fake). Determinístico e programável:
 *  - `exchangeCode`: o código `rt-<x>` devolve o refresh token `rt-<x>` (o teste escolhe o token dublado);
 *  - `refresh`: `invalidate(token)` faz o token seguinte falhar com `invalid_grant`; `rotateTo` devolve um refresh novo.
 */
export class FakeTactiqOAuth implements TactiqOAuthPort {
  readonly authorizeCalls: Array<{ state: string; codeChallenge: string }> = [];
  readonly exchangeCalls: Array<{ code: string; codeVerifier: string }> = [];
  readonly refreshCalls: string[] = [];
  private readonly invalid = new Set<string>();
  private nextRotation: string | null = null;

  async buildAuthorizeUrl(input: { state: string; codeChallenge: string }): Promise<string> {
    this.authorizeCalls.push(input);
    return `https://fake-tactiq.example.test/oauth/authorize?state=${encodeURIComponent(input.state)}&code_challenge=${encodeURIComponent(input.codeChallenge)}&code_challenge_method=S256`;
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<TactiqTokenSet & { refreshToken: string }> {
    this.exchangeCalls.push(input);
    if (input.code === 'bad-code') throw new TactiqInvalidGrantError();
    return { accessToken: `at-${input.code}`, refreshToken: input.code.startsWith('rt-') ? input.code : `rt-${input.code}` };
  }

  async refresh(refreshToken: string): Promise<TactiqTokenSet> {
    this.refreshCalls.push(refreshToken);
    if (this.invalid.has(refreshToken)) throw new TactiqInvalidGrantError();
    const rotated = this.nextRotation;
    this.nextRotation = null;
    return { accessToken: `at-${refreshToken}`, ...(rotated ? { refreshToken: rotated } : {}) };
  }

  invalidate(refreshToken: string): void {
    this.invalid.add(refreshToken);
  }

  rotateTo(newRefreshToken: string): void {
    this.nextRotation = newRefreshToken;
  }
}

/** Dublê do MCP: `ping` passa, ou lança o erro programado (ex.: `TactiqUnauthorizedError`). */
export class FakeTactiqMcp implements TactiqMcpPort {
  readonly pingTokens: string[] = [];
  pingError: Error | null = null;
  meetings: TactiqMeetingItem[] = [];
  transcript: TactiqTranscriptPage = { page: 1, totalPages: 1, totalChars: 0, hasMore: false, entries: [] };

  async ping(accessToken: string): Promise<void> {
    this.pingTokens.push(accessToken);
    if (this.pingError) throw this.pingError;
  }

  async searchMeetings(): Promise<TactiqMeetingItem[]> {
    return this.meetings;
  }

  async getTranscriptPage(): Promise<TactiqTranscriptPage> {
    return this.transcript;
  }
}
