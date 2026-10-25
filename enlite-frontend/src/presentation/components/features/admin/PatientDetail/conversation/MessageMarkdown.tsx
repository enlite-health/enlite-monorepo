import type { ReactNode, JSX } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Mesma regra de `<@uid>` que o compositor grava no corpo da mensagem. */
export const MENTION_PATTERN = /<@([^>]+)>/g;

const MENTION_HREF = /^#mention-(\d+)$/;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Whitelist (plan D3): quem liberar `img` edita esta lista E o teste de segurança. */
const ALLOWED = [
  'p', 'br', 'strong', 'em', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'code', 'pre', 'a', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del', 'input',
];

const BLOCK_TEXT = 'whitespace-pre-wrap break-words';

interface MessageMarkdownProps {
  body: string;
  /** uids CONFIRMADOS pelo servidor; token fora deste conjunto fica como texto cru. */
  mentions: readonly string[];
  renderMention: (uid: string) => ReactNode;
}

/**
 * Troca cada `<@uid>` confirmado por `[@](#mention-<i>)` ANTES do parse (plan D2): o uid vem do
 * próprio token, nunca da posição na lista, e um uid com `*`/`_` não é quebrado pelo parser.
 */
function replaceMentions(body: string, mentions: readonly string[]): { text: string; uids: string[] } {
  const confirmed = new Set(mentions);
  const uids: string[] = [];
  const text = body.replace(new RegExp(MENTION_PATTERN.source, 'g'), (token, uid: string) => {
    if (!confirmed.has(uid)) return token;
    uids.push(uid);
    return `[@](#mention-${uids.length - 1})`;
  });
  return { text, uids };
}

function buildComponents(uids: string[], renderMention: (uid: string) => ReactNode): Components {
  return {
    a: ({ href, children }) => {
      const mention = MENTION_HREF.exec(href ?? '');
      if (mention && uids[Number(mention[1])] !== undefined) {
        return <>{renderMention(uids[Number(mention[1])])}</>;
      }
      const target = (href ?? '').trim();
      if (SAFE_LINK.test(target)) {
        return (
          <a
            href={target}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline text-primary"
          >
            {children}
          </a>
        );
      }
      return <span>{children}</span>;
    },
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-gray-200 bg-gray-100 px-2 py-1 text-left font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border border-gray-200 px-2 py-1">{children}</td>,
    del: ({ children }) => <del className="line-through">{children}</del>,
    // Só a caixinha da task list do GFM, sempre somente leitura; qualquer outro type não renderiza.
    input: ({ type, checked }) =>
      type === 'checkbox' ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null,
    p: ({ children }) => <p className={BLOCK_TEXT}>{children}</p>,
    li: ({ children }) => <li className={BLOCK_TEXT}>{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className={`${BLOCK_TEXT} border-l-2 border-gray-200 pl-3`}>{children}</blockquote>
    ),
    ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
    h1: ({ children }) => <h1 className="text-sm font-semibold">{children}</h1>,
    h2: ({ children }) => <h2 className="text-sm font-semibold">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
    h4: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
    h5: ({ children }) => <h5 className="text-sm font-semibold">{children}</h5>,
    h6: ({ children }) => <h6 className="text-sm font-semibold">{children}</h6>,
    pre: ({ children }) => (
      <pre className="overflow-x-auto rounded bg-gray-100 p-2 text-xs">{children}</pre>
    ),
    code: ({ children, className }) => (
      <code className={className ?? 'rounded bg-gray-100 px-1 text-xs'}>{children}</code>
    ),
  };
}

/**
 * Corpo da mensagem do chat do paciente em markdown seguro: whitelist de elementos, sem HTML cru,
 * links só http/https/mailto e menção confirmada como chip. Puro: sem estado, sem efeito e sem
 * log (o corpo pode ser texto clínico).
 */
export function MessageMarkdown({ body, mentions, renderMention }: MessageMarkdownProps): JSX.Element {
  const { text, uids } = replaceMentions(body, mentions);
  return (
    <div className="text-sm break-words [&>*+*]:mt-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={ALLOWED}
        unwrapDisallowed
        components={buildComponents(uids, renderMention)}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
