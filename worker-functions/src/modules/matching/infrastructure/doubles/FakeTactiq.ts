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

/**
 * Dublê do MCP: `ping` passa, ou lança o erro programado (ex.: `TactiqUnauthorizedError`).
 *
 * Importação (spec 049 F6): o que a CONTA enxerga é por TOKEN (`meetingsByToken`) — é assim que o teste prova "autor errado"
 * (o token do responsável não vê a reunião). Sem programação por token, vale `meetings`. As páginas da transcrição vêm de
 * `pagesByMeeting` (id da reunião -> páginas); sem isso, vale `transcript`. Todas as chamadas ficam registradas.
 * `gate`: se definido, `searchMeetings` espera por ele (prova de execuções sobrepostas).
 */
export class FakeTactiqMcp implements TactiqMcpPort {
  readonly pingTokens: string[] = [];
  readonly searchCalls: Array<{ token: string; query: string; dateFrom: string; dateTo: string }> = [];
  readonly transcriptCalls: Array<{ token: string; meetingId: string; page: number }> = [];
  pingError: Error | null = null;
  searchError: Error | null = null;
  transcriptError: Error | null = null;
  meetings: TactiqMeetingItem[] = [];
  readonly meetingsByToken = new Map<string, TactiqMeetingItem[]>();
  readonly pagesByMeeting = new Map<string, TactiqTranscriptPage[]>();
  transcript: TactiqTranscriptPage = { page: 1, totalPages: 1, totalChars: 0, hasMore: false, entries: [] };
  gate: Promise<void> | null = null;

  async ping(accessToken: string): Promise<void> {
    this.pingTokens.push(accessToken);
    if (this.pingError) throw this.pingError;
  }

  async searchMeetings(
    accessToken: string,
    input: { query: string; dateFrom: string; dateTo: string },
  ): Promise<TactiqMeetingItem[]> {
    this.searchCalls.push({ token: accessToken, ...input });
    if (this.gate) await this.gate;
    if (this.searchError) throw this.searchError;
    return this.meetingsByToken.get(accessToken) ?? this.meetings;
  }

  async getTranscriptPage(accessToken: string, meetingId: string, page: number): Promise<TactiqTranscriptPage> {
    this.transcriptCalls.push({ token: accessToken, meetingId, page });
    if (this.transcriptError) throw this.transcriptError;
    const pages = this.pagesByMeeting.get(meetingId);
    if (!pages) return this.transcript;
    const found = pages[page - 1];
    if (!found) throw new Error('fake_tactiq_page_out_of_range');
    return found;
  }

  reset(): void {
    this.pingTokens.length = 0;
    this.searchCalls.length = 0;
    this.transcriptCalls.length = 0;
    this.pingError = null;
    this.searchError = null;
    this.transcriptError = null;
    this.meetings = [];
    this.meetingsByToken.clear();
    this.pagesByMeeting.clear();
    this.gate = null;
  }
}
