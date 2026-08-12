import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, HelpCircle } from 'lucide-react';
import { Heading, Text } from '@presentation/components/atoms';
import type { ManagementHelpKey } from './helpKeys';

const CLOSE_MS = 300;

/** Ordem fixa das seções do documento; `ojo` só aparece quando o locale a tem. */
const SECTION_ORDER = ['que', 'origen', 'cambia', 'ojo'] as const;

/**
 * Linhas de uma seção: parágrafos e bullets ("• ") vêm do locale separados por
 * '\n'. Bullets consecutivos viram uma <ul>; o resto, parágrafos.
 */
function SectionBody({ content }: { content: string }): JSX.Element {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const blocks: Array<{ type: 'p'; text: string } | { type: 'ul'; items: string[] }> = [];
  for (const line of lines) {
    if (line.startsWith('• ')) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ul') last.items.push(line.slice(2));
      else blocks.push({ type: 'ul', items: [line.slice(2)] });
    } else {
      blocks.push({ type: 'p', text: line });
    }
  }
  return (
    <div className="space-y-2">
      {blocks.map((block, i) =>
        block.type === 'p' ? (
          <Text key={i} as="p" size="sm" className="text-slate-600 dark:text-slate-300">
            {block.text}
          </Text>
        ) : (
          <ul key={i} className="space-y-1.5 pl-1">
            {block.items.map((item, j) => (
              <li key={j} className="flex items-start gap-2">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" aria-hidden="true" />
                <Text as="span" size="sm" className="text-slate-600 dark:text-slate-300">
                  {item}
                </Text>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

/**
 * Painel lateral direito "¿Qué es este número?" da Gestión a la Vista.
 *
 * Mesmo padrão de side-sheet dos drawers de edição do admin (backdrop + painel
 * fixed right com rounded-tl/bl, Escape fecha, transição de 300ms, montagem
 * condicional pelo pai). Conteúdo 100% via i18n — ver `helpKeys.ts`.
 */
export function HelpDrawer({
  helpKey,
  onClose,
}: {
  helpKey: ManagementHelpKey;
  onClose: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const base = `admin.managementDashboard.help.${helpKey}`;

  const [show, setShow] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => {
    setShow(false);
    setTimeout(onClose, CLOSE_MS);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sections = SECTION_ORDER.filter((s) => i18n.exists(`${base}.${s}`));

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${
          show ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleClose}
        data-testid="mgmt-help-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(`${base}.title`)}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white dark:bg-slate-900 shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${
          show ? 'translate-x-0' : 'translate-x-full'
        }`}
        data-testid="mgmt-help-drawer"
      >
        <div className="flex items-center justify-between gap-4 px-8 py-5 border-b border-slate-100 dark:border-slate-700 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <HelpCircle className="h-5 w-5 text-primary" aria-hidden="true" />
            </span>
            <Heading level={3} weight="semibold" color="primary">
              {t(`${base}.title`)}
            </Heading>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label={t('common.close')}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors p-1 rounded"
            data-testid="mgmt-help-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
          {sections.map((section) => (
            <section key={section} data-testid={`mgmt-help-${section}`}>
              <Text
                as="p"
                size="xs"
                weight="semibold"
                className="mb-2 uppercase tracking-wide text-slate-400 dark:text-slate-500"
              >
                {t(`admin.managementDashboard.help._sections.${section}`)}
              </Text>
              <SectionBody content={t(`${base}.${section}`)} />
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
