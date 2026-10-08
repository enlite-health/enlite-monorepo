import {
  ReactNode,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
  HTMLAttributes,
} from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { Text } from '../Text';

type Align = 'left' | 'center' | 'right';
type CellWeight = 'normal' | 'medium' | 'semibold';

const alignClass = (align: Align): string =>
  align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  children: ReactNode;
  /** Quando true, envolve a tabela em um wrapper com overflow-x-auto. Default: true. */
  scrollable?: boolean;
}

export function Table({
  children,
  className = '',
  scrollable = true,
  ...rest
}: TableProps): JSX.Element {
  const table = (
    <table {...rest} className={`w-full font-lexend ${className}`}>
      {children}
    </table>
  );

  if (!scrollable) return table;

  return <div className="overflow-x-auto">{table}</div>;
}

interface TableHeaderProps extends HTMLAttributes<HTMLTableSectionElement> {
  children: ReactNode;
}

export function TableHeader({
  children,
  className = '',
  ...rest
}: TableHeaderProps): JSX.Element {
  return (
    <thead {...rest} className={className}>
      <tr className="bg-gray-300 text-gray-800">{children}</tr>
    </thead>
  );
}

interface TableBodyProps extends HTMLAttributes<HTMLTableSectionElement> {
  children: ReactNode;
}

export function TableBody({
  children,
  className = '',
  ...rest
}: TableBodyProps): JSX.Element {
  return (
    <tbody {...rest} className={className}>
      {children}
    </tbody>
  );
}

interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  children: ReactNode;
  /** Aplica cursor-pointer + hover. Default: true se onClick presente. */
  clickable?: boolean;
}

export function TableRow({
  children,
  className = '',
  onClick,
  clickable,
  ...rest
}: TableRowProps): JSX.Element {
  const isClickable = clickable ?? !!onClick;
  const classes = [
    'border-b border-gray-600 last:border-0',
    isClickable ? 'cursor-pointer hover:bg-slate-50 transition-colors' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <tr {...rest} className={classes} onClick={onClick}>
      {children}
    </tr>
  );
}

interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
  align?: Align;
  /** Pula o wrap automático em Text — para conteúdo já estilizado (checkboxes, ícones). */
  unwrapped?: boolean;
  /**
   * Ordenação (opcional). Sem `onSort`, o render é o de sempre. Com `onSort`, o conteúdo vira um
   * `<button type="button">`; `sortDirection` é a direção SE esta coluna é a ativa (null = inativa).
   */
  onSort?: () => void;
  sortDirection?: SortDirection | null;
}

export type SortDirection = 'asc' | 'desc';

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

export function TableHead({
  children,
  align = 'left',
  unwrapped = false,
  className = '',
  onSort,
  sortDirection = null,
  ...rest
}: TableHeadProps): JSX.Element {
  const classes = [
    alignClass(align),
    'px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const isEmpty = children === undefined || children === null;

  if (onSort) {
    const Icon = sortDirection === 'desc' ? ChevronDown : ChevronUp;
    return (
      <th
        {...rest}
        className={classes}
        aria-sort={sortDirection ? ARIA_SORT[sortDirection] : 'none'}
      >
        <button
          type="button"
          onClick={onSort}
          className="inline-flex items-center gap-1 cursor-pointer bg-transparent p-0 text-inherit"
        >
          <Text as="span" size="sm" weight="medium" color="inherit">
            {children}
          </Text>
          {sortDirection && (
            <Icon className="w-3.5 h-3.5" aria-hidden="true" data-sort-icon={sortDirection} />
          )}
        </button>
      </th>
    );
  }

  return (
    <th {...rest} className={classes}>
      {isEmpty ? null : unwrapped ? (
        children
      ) : (
        <Text as="span" size="sm" weight="medium" color="inherit">
          {children}
        </Text>
      )}
    </th>
  );
}

interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
  align?: Align;
  weight?: CellWeight;
  /** Pula o wrap automático em Text — para conteúdo já estilizado (badges, links, componentes complexos). */
  unwrapped?: boolean;
}

export function TableCell({
  children,
  align = 'left',
  weight = 'normal',
  unwrapped = false,
  className = '',
  ...rest
}: TableCellProps): JSX.Element {
  const classes = [alignClass(align), 'px-3 py-2', className]
    .filter(Boolean)
    .join(' ');

  return (
    <td {...rest} className={classes}>
      {unwrapped || children === undefined || children === null ? (
        children
      ) : (
        <Text as="span" size="sm" weight={weight} color="inherit">
          {children}
        </Text>
      )}
    </td>
  );
}
