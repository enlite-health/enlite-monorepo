/**
 * MessageMarkdown — testes unitários (spec 072, T1): formatação, menção e compatibilidade.
 * Textos sintéticos, não clínicos.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageMarkdown } from '../MessageMarkdown';

function renderBody(body: string, mentions: readonly string[] = []) {
  return render(
    <MessageMarkdown
      body={body}
      mentions={mentions}
      renderMention={(uid) => <span data-testid="mention-chip">@{uid}</span>}
    />,
  );
}

describe('formatação', () => {
  it('F1 negrito vira strong', () => {
    const { container } = renderBody('texto **forte** aqui');
    const nodes = container.querySelectorAll('strong');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe('forte');
  });

  it('F2 itálico vira em', () => {
    const { container } = renderBody('texto *suave* aqui');
    expect(container.querySelectorAll('em')).toHaveLength(1);
  });

  it('F3 lista com linha em branco entre itens vira 1 ul e 2 li', () => {
    const { container } = renderBody('- item um\n\n- item dois');
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('F4 lista numerada vira 1 ol e 2 li', () => {
    const { container } = renderBody('1. primeiro\n2. segundo');
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('F5 título vira h1 sem o #', () => {
    const { container } = renderBody('# Título');
    const h1 = container.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe('Título');
    expect(container.textContent).not.toContain('#');
  });

  it('F6 quebra simples segue visível (p com whitespace-pre-wrap)', () => {
    const { container } = renderBody('linha 1\nlinha 2');
    const p = container.querySelector('p');
    expect(p?.className).toContain('whitespace-pre-wrap');
    expect(p?.textContent).toBe('linha 1\nlinha 2');
  });

  it('F7 código inline e bloco cercado', () => {
    const inline = renderBody('veja `x` aqui');
    expect(inline.container.querySelector('code')?.textContent).toBe('x');
    const block = renderBody('```\nlinha\n```');
    expect(block.container.querySelector('pre > code')).not.toBeNull();
  });

  it('F8 citação vira blockquote', () => {
    const { container } = renderBody('> citação');
    expect(container.querySelectorAll('blockquote')).toHaveLength(1);
  });
});

describe('menção', () => {
  it('M1 menção confirmada convive com negrito', () => {
    const { container } = renderBody('Oi <@uidA>, veja **isto**', ['uidA']);
    expect(screen.getAllByTestId('mention-chip')).toHaveLength(1);
    expect(container.querySelectorAll('strong')).toHaveLength(1);
  });

  it('M2 casa por uid, não por posição', () => {
    renderBody('<@zeta> e <@alfa>', ['alfa', 'zeta']);
    const chips = screen.getAllByTestId('mention-chip').map((n) => n.textContent);
    expect(chips).toEqual(['@zeta', '@alfa']);
  });

  it('M3 token fora de mentions fica como texto cru', () => {
    const { container } = renderBody('oi <@x>', []);
    expect(container.textContent).toContain('<@x>');
    expect(screen.queryAllByTestId('mention-chip')).toHaveLength(0);
  });

  it('M4 chip dentro de negrito', () => {
    const { container } = renderBody('**<@uidA>**', ['uidA']);
    expect(container.querySelector('strong [data-testid="mention-chip"]')).not.toBeNull();
  });

  it('M5 spoof de âncora de menção não vira chip nem link', () => {
    const { container } = renderBody('[x](#mention-0)', []);
    expect(screen.queryAllByTestId('mention-chip')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('x');
  });

  it('M6 menção dentro de código não lança nem injeta elementos', () => {
    let container!: HTMLElement;
    expect(() => {
      ({ container } = renderBody('`<@uidA>`', ['uidA']));
    }).not.toThrow();
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('compatibilidade', () => {
  it('C1 texto simples sai idêntico', () => {
    const { container } = renderBody('texto simples sem sintaxe');
    expect(container.textContent).toBe('texto simples sem sintaxe');
  });

  it('C2 4000 asteriscos renderizam sem lançar', () => {
    expect(() => renderBody('*'.repeat(4000))).not.toThrow();
  });
});

describe('segurança', () => {
  const pwn = () => (window as unknown as { __pwn?: unknown }).__pwn;
  beforeEach(() => {
    delete (window as unknown as { __pwn?: unknown }).__pwn;
  });

  it('S1 HTML cru não vira elemento e aparece como texto', () => {
    const { container } = renderBody('<script>window.__pwn=1</script><img src=x onerror="window.__pwn=1">');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(pwn()).toBeUndefined();
    expect(container.textContent).toContain('<script>');
  });

  it('S2 esquemas perigosos não viram link', () => {
    const { container } = renderBody(
      '[a](javascript:window.__pwn=1) [b](data:text/html;base64,AAAA) [c](vbscript:x) [d]( jAvAsCrIpT:window.__pwn=1)',
    );
    expect(
      container.querySelector('a[href^="javascript" i], a[href^="data" i], a[href^="vbscript" i]'),
    ).toBeNull();
    expect(pwn()).toBeUndefined();
  });

  it('S3 link https abre em nova aba com rel seguro', () => {
    const { container } = renderBody('[doc](https://exemplo.test/p)');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://exemplo.test/p');
    expect(links[0].getAttribute('target')).toBe('_blank');
    const rel = links[0].getAttribute('rel') ?? '';
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
    expect(rel).toContain('nofollow');
  });

  it('S4 imagem markdown não vira img', () => {
    const { container } = renderBody('![x](https://tracker.test/pixel.png)');
    expect(container.querySelector('img')).toBeNull();
  });

  it('S5 HTML cru de âncora não vira a', () => {
    const { container } = renderBody('<a href="javascript:alert(1)">x</a>');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<a href=');
  });

  it('S6 link relativo, protocol-relative e âncora não viram a', () => {
    const { container } = renderBody('[r](/admin/pacientes) [s](//evil.test/x) [t](#ancora)');
    expect(container.querySelector('a')).toBeNull();
  });

  it('S7 tel, ftp e file não viram a', () => {
    const { container } = renderBody('[u](tel:+000) [v](ftp://x.test/f) [w](file:///etc/x)');
    expect(container.querySelector('a')).toBeNull();
  });

  it('S8 mailto vira link', () => {
    const { container } = renderBody('[m](mailto:time@exemplo.test)');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')?.startsWith('mailto:')).toBe(true);
  });
});
