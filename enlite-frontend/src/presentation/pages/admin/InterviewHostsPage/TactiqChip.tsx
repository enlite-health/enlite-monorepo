import { CheckCircle2, Link2Off } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Estado do vínculo Tactiq — só leitura; o vínculo é ato da própria pessoa em "Mi perfil". */
export function TactiqChip({ linked, id }: { linked: boolean; id: string }): JSX.Element {
  const { t } = useTranslation();
  if (linked) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-800" data-testid="tactiq-vinculado">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        {t('admin.interviewHosts.tactiqLinked')}
      </span>
    );
  }
  const tipId = `tactiq-tip-${id}`;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full bg-gray-200 px-3 py-1 text-sm font-medium text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-help"
        aria-describedby={tipId}
        data-testid="tactiq-sin-vincular"
      >
        <Link2Off className="h-4 w-4" aria-hidden="true" />
        {t('admin.interviewHosts.tactiqUnlinked')}
      </button>
      <span
        id={tipId}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-60 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-2 text-center text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {t('admin.interviewHosts.tactiqTip')}
      </span>
    </span>
  );
}
