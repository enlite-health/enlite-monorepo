/** Só para teste: liga `useWeekNavigation` à `AnaCareHoursDetailPage` como o `AnaCareHoursDetailContainer` faz (sem busca). */
import type { ComponentProps } from 'react';
import { useWeekNavigation } from '@hooks/admin/useWeekNavigation';
import { AnaCareHoursDetailPage } from './AnaCareHoursDetailPage';

type PageProps = ComponentProps<typeof AnaCareHoursDetailPage>;

export function AnaCareHoursDetailPageWithNav(props: Omit<PageProps, 'weekNav'> & { onMonthChange?: (month: string) => void }): JSX.Element {
  const { onMonthChange, ...rest } = props;
  const weekNav = useWeekNavigation(props.snapshot.month, onMonthChange);
  return <AnaCareHoursDetailPage {...rest} weekNav={weekNav} />;
}
