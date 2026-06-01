import { logger } from '../../../shared/logging/Logger';
import type { McpAuditEvent } from '../domain/McpAuditEvent';

const PII_FIELDS = new Set([
  'cpf',
  'rg',
  'documentNumber',
  'email',
  'phone',
  'birthDate',
  'address',
  'mediaUrl',
  'externalUrl',
  'firstName',
  'lastName',
]);

export class McpAuditLogger {
  emit(event: McpAuditEvent): void {
    logger.info(
      {
        audit: {
          ...event,
          argsRedacted: this.redact(event.argsRedacted),
        },
      },
      `mcp.audit.${event.capability}`,
    );
  }

  /**
   * Redaction básica: replace de valores PII por hash/last4/null.
   * Exposto pra teste.
   */
  redact(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (PII_FIELDS.has(k)) {
        if (typeof v === 'string') {
          out[k] = this.redactStringByField(k, v);
        } else {
          out[k] = '***';
        }
      } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = this.redact(v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private redactStringByField(field: string, value: string): string {
    if (field === 'cpf' || field === 'rg' || field === 'documentNumber') {
      return value.length >= 4 ? `***${value.slice(-4)}` : '***';
    }
    if (field === 'email') {
      return this.redactEmail(value);
    }
    if (field === 'phone') {
      return value.length >= 4 ? `***${value.slice(-4)}` : '***';
    }
    if (field === 'birthDate') {
      return value.length >= 4 ? value.slice(0, 4) : '***';
    }
    if (field === 'mediaUrl' || field === 'externalUrl') {
      return this.stripQueryString(value);
    }
    return '***';
  }

  private redactEmail(email: string): string {
    const at = email.indexOf('@');
    if (at < 0) return '***';
    return `***${email.slice(at)}`;
  }

  private stripQueryString(url: string): string {
    try {
      const u = new URL(url);
      u.search = '';
      return u.toString();
    } catch {
      return '***';
    }
  }
}
