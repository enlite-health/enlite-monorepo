import { useTranslation } from 'react-i18next';
import { House, LoaderCircle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';

const bar = 'rounded-lg bg-gray-300';

/** F1 (E1.1–E1.2): círculo tracejado + cartão de status sobre o mapa ainda sem coordenada. */
export function InviteMapLoading({ address }: { address: string | null }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div data-testid="invite-map-loading" className="relative h-full w-full overflow-hidden bg-gray-200">
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-[260px] w-[260px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-[#F227AF] bg-[#F227AF]/5"
      />
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 flex h-[34px] w-[34px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[3px] border-white bg-[#111827] shadow-[0_4px_10px_rgba(0,0,0,.25)]"
      >
        <House size={16} className="text-white" />
      </div>
      <div
        role="status"
        data-testid="invite-loading-status"
        className="absolute bottom-[72px] left-1/2 flex w-max max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-white px-5 py-3.5 shadow-[0_8px_24px_rgba(0,0,0,.12)]"
      >
        <LoaderCircle size={20} className="shrink-0 animate-spin text-primary" />
        <div>
          <Text size="sm" weight="medium" color="primary">
            {address
              ? t('admin.vacancyInvite.loading.title', { address })
              : t('admin.vacancyInvite.loading.titleNoAddress')}
          </Text>
          <Text size="xs" color="inherit" className="text-primary/70">
            {t('admin.vacancyInvite.loading.subtitle')}
          </Text>
        </div>
      </div>
    </div>
  );
}

/** F1 (E1.3): esqueleto da lista — barra, 4 cartões, 6 linhas, rodapé. */
export function InviteListSkeleton(): JSX.Element {
  return (
    <div data-testid="invite-list-skeleton" aria-hidden="true" className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b border-gray-300 px-6 pb-4 pt-5">
        <div className={`${bar} h-4 w-[360px] max-w-full`} />
        <div className="flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[72px] flex-1 rounded-2xl border border-gray-300 bg-gray-200" />
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {[60, 52, 45, 56, 40, 35].map((w, i) => (
          <div key={i} className="flex h-16 items-center gap-3 border-b border-gray-300 px-6">
            <div className="h-5 w-5 rounded-md bg-gray-300" />
            <div className="h-8 w-8 rounded-full bg-gray-300" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className={`${bar} h-3`} style={{ width: `${w}%` }} />
              <div className={`${bar} h-2.5`} style={{ width: `${w - 20}%` }} />
            </div>
            <div className={`${bar} h-3 w-14`} />
          </div>
        ))}
      </div>
      <div className="flex h-[72px] items-center justify-between border-t border-gray-300 px-6">
        <div className="h-10 w-[220px] rounded-[10px] bg-gray-300" />
        <div className="h-10 w-[180px] rounded-[10px] bg-gray-300" />
      </div>
    </div>
  );
}
