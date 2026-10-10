import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  TactiqNotConfiguredError,
  TactiqRealClientInTestError,
  TactiqTransientError,
  TactiqUnauthorizedError,
  type TactiqMcpPort,
  type TactiqMeetingItem,
  type TactiqTranscriptPage,
} from '../../application/ports/TactiqPorts';
import { classifyMcpFailure, parseMcpJson, pingVerdict } from './tactiqMcpProtocol';

const CALL_TIMEOUT_MS = 20_000;

/**
 * Cliente REAL do MCP do Tactiq (Streamable HTTP, token Bearer do OPERADOR). Uma conexão curta por chamada — o volume
 * é de uma varredura diária e de poucas importações por dia. Nunca loga conteúdo, token nem corpo de resposta.
 * O limite de 10 reuniões/h/usuário (spec §3.3) é de quem consome (importação, F6).
 *
 * ⚠️ Lança no construtor com NODE_ENV=test: teste nunca toca o Tactiq.
 */
export class TactiqMcpClient implements TactiqMcpPort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    if (this.env.NODE_ENV === 'test') throw new TactiqRealClientInTestError('new TactiqMcpClient()');
  }

  async ping(accessToken: string): Promise<void> {
    const raw = await this.callTool(accessToken, 'get_access_options', {});
    if (pingVerdict(raw) === 'denied') throw new TactiqUnauthorizedError();
  }

  async searchMeetings(accessToken: string, input: { query: string; dateFrom: string; dateTo: string }): Promise<TactiqMeetingItem[]> {
    const raw = parseMcpJson(await this.callTool(accessToken, 'search_meetings', input));
    const items = Array.isArray((raw as { meetings?: unknown })?.meetings)
      ? (raw as { meetings: unknown[] }).meetings
      : Array.isArray(raw) ? raw : [];
    return items.flatMap((m) => {
      const r = m as Record<string, unknown>;
      return typeof r.id === 'string' && typeof r.title === 'string' && typeof r.createdAt === 'string'
        ? [{ id: r.id, title: r.title, createdAt: r.createdAt, durationSeconds: Number(r.durationSeconds) || 0 }]
        : [];
    });
  }

  async getTranscriptPage(accessToken: string, meetingId: string, page: number): Promise<TactiqTranscriptPage> {
    const raw = parseMcpJson(await this.callTool(accessToken, 'get_transcript', { meetingId, page })) as Partial<TactiqTranscriptPage> | null;
    if (!raw || !Array.isArray(raw.entries) || typeof raw.totalChars !== 'number') throw new TactiqTransientError('transcript_malformed');
    return {
      page: Number(raw.page) || page,
      totalPages: Number(raw.totalPages) || 1,
      totalChars: raw.totalChars,
      hasMore: Boolean(raw.hasMore),
      entries: raw.entries,
    };
  }

  private async callTool(accessToken: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const mcpUrl = this.env.TACTIQ_MCP_URL;
    if (!mcpUrl) throw new TactiqNotConfiguredError('TACTIQ_MCP_URL');
    const client = new Client({ name: 'enlite-admission', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
      if (result.isError) throw new TactiqTransientError(`tool_${name}_error`);
      return result;
    } catch (err) {
      throw classifyMcpFailure(err);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
