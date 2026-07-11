/**
 * sendgridReporter.ts — Reporter custom do Playwright pro synthetic monitoring de prod.
 *
 * Ao fim de TODA execução (`onEnd`) ele faz DUAS coisas:
 *   1. Envia um EMAIL com o resultado do run (assunto 🔴/✅ + contagens + falhas com
 *      `arquivo:linha` + trecho do erro) via SendGrid — reusa a MESMA conta/sender
 *      verificado que o backend já usa (`enlite@enlite.health`). É a rastreabilidade que
 *      o user pediu: "qual teste e qual linha".
 *   2. Grava `test-results/failures.json` (machine-readable) — vira input do agente de
 *      auto-cura `e2e-repair` (ele lê as falhas estruturadas em vez de fazer parsing de log).
 *
 * DRY-RUN: sem `SENDGRID_API_KEY` (ou `MONITOR_EMAIL_DRYRUN=1`) NÃO envia — só loga o
 * assunto + resumo + caminho do JSON. Permite rodar local/CI sem a key.
 *
 * NB: não importamos nada do backend (worker-functions é projeto separado); replicamos o
 * mínimo (from verificado + padrão de envio) aqui. O sender TEM que ser o verificado no
 * SendGrid, senão a API rejeita — por isso o mesmo `enlite@enlite.health`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import sgMail from '@sendgrid/mail';

/** Sender verificado no SendGrid (idêntico ao EmailService do backend). SendGrid rejeita
 *  qualquer FROM não-verificado — este é o único válido. */
const VERIFIED_FROM_EMAIL = 'enlite@enlite.health';
const VERIFIED_FROM_NAME = 'Enlite';
const DEFAULT_ALERT_TO = 'gabriel.g.stein@gmail.com';
const FAILURES_JSON_PATH = 'test-results/failures.json';

/** Uma falha estruturada — o que o email lista e o que o e2e-repair consome. */
interface FailureEntry {
  title: string;
  file: string;
  line: number;
  column: number;
  error: string;
}

interface FailuresReport {
  runAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  failures: FailureEntry[];
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default class SendGridReporter implements Reporter {
  private rootDir = process.cwd();
  /** Último resultado por teste (chave = test.id), pra computar contagens no onEnd. */
  private readonly finalByTest = new Map<string, { test: TestCase; result: TestResult }>();

  onBegin(config: FullConfig, _suite: Suite): void {
    this.rootDir = config.rootDir ?? process.cwd();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // onTestEnd dispara uma vez por tentativa (retry). Guardamos a ÚLTIMA — é o veredito final.
    this.finalByTest.set(test.id, { test, result });
  }

  async onEnd(result: FullResult): Promise<void> {
    const runAt = process.env.RUN_AT ?? new Date().toISOString();
    const durationMs = Math.round(result.duration ?? 0);

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let flaky = 0;
    const failures: FailureEntry[] = [];

    for (const { test, result: testResult } of this.finalByTest.values()) {
      switch (test.outcome()) {
        case 'expected':
          passed++;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'flaky':
          flaky++;
          break;
        case 'unexpected':
          failed++;
          failures.push(this.toFailureEntry(test, testResult));
          break;
      }
    }

    const total = passed + failed + skipped + flaky;
    const report: FailuresReport = {
      runAt,
      total,
      passed,
      failed,
      skipped,
      flaky,
      durationMs,
      failures,
    };

    const failuresPath = this.writeFailuresJson(report);
    const subject = this.buildSubject(report);

    await this.deliver(subject, report, failuresPath);
  }

  private toFailureEntry(test: TestCase, result: TestResult): FailureEntry {
    const loc = test.location;
    const file = this.relFile(loc.file);
    const firstError = result.errors[0]?.message ?? result.error?.message ?? '(sem mensagem de erro)';
    let error = stripAnsi(firstError).trim();

    // Se o erro trouxe location própria (nem sempre = location do teste), anexa pra rastreio.
    const errLoc = result.errors[0]?.location;
    if (errLoc) {
      error += `\n  @ ${this.relFile(errLoc.file)}:${errLoc.line}:${errLoc.column}`;
    }

    return {
      title: test.titlePath().filter(Boolean).join(' > '),
      file,
      line: loc.line,
      column: loc.column,
      error,
    };
  }

  private relFile(absPath: string): string {
    const rel = relative(this.rootDir, absPath);
    return rel && !rel.startsWith('..') ? rel : absPath;
  }

  private buildSubject(r: FailuresReport): string {
    return r.failed > 0
      ? `🔴 Monitor Enlite prod — ${r.failed} falha(s) / ${r.total}`
      : `✅ Monitor Enlite prod — ${r.passed}/${r.total} OK`;
  }

  private writeFailuresJson(report: FailuresReport): string {
    const path = join(this.rootDir, FAILURES_JSON_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return path;
  }

  private buildTextBody(r: FailuresReport, failuresPath: string): string {
    const lines: string[] = [];
    lines.push(`Run: ${r.runAt}`);
    lines.push(`Duração: ${(r.durationMs / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push(`Total: ${r.total} · Passou: ${r.passed} · Falhou: ${r.failed} · Pulou: ${r.skipped} · Flaky: ${r.flaky}`);
    if (r.failures.length > 0) {
      lines.push('');
      lines.push('Falhas:');
      for (const f of r.failures) {
        lines.push('');
        lines.push(`  • ${f.title}`);
        lines.push(`    ${f.file}:${f.line}:${f.column}`);
        lines.push(`    ${f.error.replace(/\n/g, '\n    ')}`);
      }
    }
    lines.push('');
    lines.push(`failures.json: ${failuresPath}`);
    return lines.join('\n');
  }

  private buildHtmlBody(r: FailuresReport): string {
    const color = r.failed > 0 ? '#c0392b' : '#1e8449';
    const rows = [
      ['Total', r.total],
      ['Passou', r.passed],
      ['Falhou', r.failed],
      ['Pulou', r.skipped],
      ['Flaky', r.flaky],
    ]
      .map(
        ([label, value]) =>
          `<tr><td style="padding:4px 12px;border:1px solid #eee;">${label}</td>` +
          `<td style="padding:4px 12px;border:1px solid #eee;text-align:right;"><strong>${value}</strong></td></tr>`,
      )
      .join('');

    let failuresHtml = '';
    if (r.failures.length > 0) {
      const items = r.failures
        .map(
          (f) =>
            `<li style="margin:0 0 16px;">` +
            `<div style="font-weight:bold;color:#333;">${escapeHtml(f.title)}</div>` +
            `<div style="font-family:monospace;font-size:13px;color:#c0392b;">${escapeHtml(f.file)}:${f.line}:${f.column}</div>` +
            `<pre style="margin:6px 0 0;padding:8px 10px;background:#f7f7f7;border-radius:6px;font-size:12px;white-space:pre-wrap;color:#333;">${escapeHtml(f.error)}</pre>` +
            `</li>`,
        )
        .join('');
      failuresHtml = `<h3 style="color:#c0392b;">Falhas</h3><ul style="list-style:none;padding:0;">${items}</ul>`;
    }

    return `
<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#333;">
  <h2 style="color:${color};margin-bottom:4px;">Monitor Enlite prod</h2>
  <p style="color:#666;margin-top:0;font-size:13px;">Run: ${escapeHtml(r.runAt)} · Duração: ${(r.durationMs / 1000).toFixed(1)}s</p>
  <table style="border-collapse:collapse;margin:12px 0;">${rows}</table>
  ${failuresHtml}
  <p style="color:#999;font-size:11px;margin-top:24px;">Email automático do synthetic monitoring (e2e-prod). Enviado a cada run.</p>
</div>`;
  }

  private async deliver(subject: string, report: FailuresReport, failuresPath: string): Promise<void> {
    const apiKey = process.env.SENDGRID_API_KEY;
    const to = process.env.MONITOR_ALERT_TO ?? DEFAULT_ALERT_TO;
    const dryRun = !apiKey || process.env.MONITOR_EMAIL_DRYRUN === '1';

    const summary =
      `total=${report.total} passed=${report.passed} failed=${report.failed} ` +
      `skipped=${report.skipped} flaky=${report.flaky}`;

    if (dryRun) {
      const reason = !apiKey ? 'SENDGRID_API_KEY ausente' : 'MONITOR_EMAIL_DRYRUN=1';
      // eslint-disable-next-line no-console
      console.log(
        `\n[sendgridReporter] DRY-RUN (${reason}) — email NÃO enviado.\n` +
          `  Assunto: ${subject}\n` +
          `  Para: ${to}\n` +
          `  Resumo: ${summary}\n` +
          `  failures.json: ${failuresPath}`,
      );
      return;
    }

    try {
      sgMail.setApiKey(apiKey);
      await sgMail.send({
        to,
        from: { email: VERIFIED_FROM_EMAIL, name: VERIFIED_FROM_NAME },
        subject,
        text: this.buildTextBody(report, failuresPath),
        html: this.buildHtmlBody(report),
      });
      // eslint-disable-next-line no-console
      console.log(`\n[sendgridReporter] Email enviado → ${to} · ${subject} · ${summary}`);
    } catch (err) {
      // Falha de envio NÃO derruba o processo — o exit code do Playwright é o que vale pro job.
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`\n[sendgridReporter] FALHA ao enviar email (ignorada): ${message}`);
    }
  }
}
