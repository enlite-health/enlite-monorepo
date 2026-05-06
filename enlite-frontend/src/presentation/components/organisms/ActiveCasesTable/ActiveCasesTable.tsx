/**
 * ActiveCasesTable Organism
 * Displays active recruitment cases with sorting and conditional colors
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBadge } from '@presentation/components/atoms/StatusBadge';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import type { ActiveCase } from '@domain/entities/RecruitmentData';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface ActiveCasesTableProps {
  cases: ActiveCase[];
  onCaseClick: (caseNumber: string) => void;
  reemplazosColors?: Record<string, 'red' | 'yellow' | 'green'>;
  className?: string;
}

type SortKey = 'id' | 'name' | 'status' | 'inicioBusqueda';
type SortDirection = 'asc' | 'desc';

export function ActiveCasesTable({
  cases,
  onCaseClick,
  reemplazosColors,
  className = '',
}: ActiveCasesTableProps): JSX.Element {
  const { t } = useTranslation();
  const [sortConfig, setSortConfig] = useState<{ key: keyof ActiveCase; direction: 'asc' | 'desc' } | null>(null);

  const getRowColorClass = (caseNumber: string): string => {
    if (!reemplazosColors) return '';
    const color = reemplazosColors[caseNumber];
    if (color === 'red') return 'bg-red-50 hover:bg-red-100';
    if (color === 'yellow') return 'bg-yellow-50 hover:bg-yellow-100';
    if (color === 'green') return 'bg-green-50 hover:bg-green-100';
    return '';
  };

  const sortedCases = useMemo(() => {
    if (!sortConfig) return cases;

    const sorted = [...cases].sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      switch (sortConfig.key) {
        case 'id':
          aVal = parseInt(a.id) || a.id;
          bVal = parseInt(b.id) || b.id;
          break;
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'status':
          aVal = a.status;
          bVal = b.status;
          break;
        case 'inicioBusqueda': {
          const dA = a.inicioBusquedaObj.getTime();
          const dB = b.inicioBusquedaObj.getTime();
          if (!isNaN(dA) && !isNaN(dB)) {
            return sortConfig.direction === 'asc' ? dA - dB : dB - dA;
          }
          aVal = a.inicioBusqueda;
          bVal = b.inicioBusqueda;
          break;
        }
      }

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [cases, sortConfig]);

  const requestSort = (key: SortKey): void => {
    let direction: SortDirection = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const renderSortIcon = (key: SortKey): JSX.Element => {
    if (!sortConfig || sortConfig.key !== key) {
      return <span className="text-slate-300 ml-1 opacity-0 group-hover:opacity-100">↕</span>;
    }
    return sortConfig.direction === 'asc' ? (
      <ChevronUp className="w-4 h-4 ml-1 text-primary inline" />
    ) : (
      <ChevronDown className="w-4 h-4 ml-1 text-primary inline" />
    );
  };

  if (cases.length === 0) {
    return (
      <div className="text-center py-12">
        <Text size="sm" color="muted">
          {t('admin.recruitment.caseAnalysis.noCase')}
        </Text>
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden shadow ring-1 ring-black ring-opacity-5 sm:rounded-lg overflow-x-auto ${className}`}
    >
      <Table className="min-w-full">
        <TableHeader>
          <TableHead
            scope="col"
            onClick={() => requestSort('id')}
            className="cursor-pointer group hover:bg-gray-400 transition-colors select-none"
          >
            {t('admin.recruitment.table.caseNumber')}
            {renderSortIcon('id')}
          </TableHead>
          <TableHead
            scope="col"
            onClick={() => requestSort('name')}
            className="cursor-pointer group hover:bg-gray-400 transition-colors select-none"
          >
            {t('admin.recruitment.table.taskName')}
            {renderSortIcon('name')}
          </TableHead>
          <TableHead
            scope="col"
            onClick={() => requestSort('status')}
            className="cursor-pointer group hover:bg-gray-400 transition-colors select-none"
          >
            {t('admin.recruitment.table.status')}
            {renderSortIcon('status')}
          </TableHead>
          <TableHead
            scope="col"
            onClick={() => requestSort('inicioBusqueda')}
            className="cursor-pointer group hover:bg-gray-400 transition-colors select-none"
          >
            {t('admin.recruitment.table.startDate')}
            {renderSortIcon('inicioBusqueda')}
          </TableHead>
          <TableHead scope="col" align="right">
            <span className="sr-only">Acciones</span>
          </TableHead>
        </TableHeader>
        <TableBody>
          {sortedCases.map((caseItem) => (
            <TableRow
              key={caseItem.id}
              onClick={() => onCaseClick(caseItem.id)}
              className={getRowColorClass(caseItem.id)}
            >
              <TableCell weight="medium" className="whitespace-nowrap">
                {caseItem.id}
              </TableCell>
              <TableCell unwrapped className="whitespace-nowrap">
                <Text as="span" size="sm" color="muted">
                  {caseItem.name}
                </Text>
              </TableCell>
              <TableCell unwrapped className="whitespace-nowrap">
                <StatusBadge status={caseItem.status} />
              </TableCell>
              <TableCell weight="medium" className="whitespace-nowrap">
                {caseItem.inicioBusqueda}
              </TableCell>
              <TableCell unwrapped align="right" className="whitespace-nowrap">
                <Text
                  as="span"
                  size="xs"
                  weight="medium"
                  color="primary"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  {t('admin.recruitment.table.viewAnalysis')} &rarr;
                </Text>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
