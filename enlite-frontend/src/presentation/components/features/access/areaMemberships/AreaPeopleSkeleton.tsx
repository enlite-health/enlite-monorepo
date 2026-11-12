import { useTranslation } from 'react-i18next';

/** Larguras (%) das cinco células do esqueleto do desenho. */
const WIDTHS = [40, 60, 22, 50, 16];

/** "Cargando": oito linhas pulsando dentro do mesmo cartão da tabela. */
export function AreaPeopleSkeleton(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400"
      role="status"
      aria-label={t('admin.access.areaMemberships.loadingLabel')}
      data-testid="area-people-skeleton"
    >
      <div className="w-full">
        {Array.from({ length: 8 }).map((_, row) => (
          <div key={row} className="flex border-b border-gray-600 last:border-0">
            {WIDTHS.map((w, i) => (
              <div key={i} className="px-3 py-3 flex-1">
                <div className="h-4 rounded-md bg-gray-300 animate-pulse" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="sr-only">{t('admin.access.areaMemberships.loadingText')}</p>
    </div>
  );
}
