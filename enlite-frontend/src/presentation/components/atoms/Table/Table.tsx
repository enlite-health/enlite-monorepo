import {
  ReactNode,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
  HTMLAttributes,
} from 'react';
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
}

export function TableHead({
  children,
  align = 'left',
  unwrapped = false,
  className = '',
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
