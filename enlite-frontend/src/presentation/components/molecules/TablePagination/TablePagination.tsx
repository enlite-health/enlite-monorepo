import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TablePaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  startIndex: number;
  endIndex: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onItemsPerPageChange: (value: number) => void;
}

export const TablePagination = ({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  startIndex,
  endIndex,
  onPrevPage,
  onNextPage,
  onItemsPerPageChange,
}: TablePaginationProps): JSX.Element => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-end gap-4">
      <div className="relative w-[100px]">
        <select
          aria-label={t('common.rowsPerPage')}
          value={itemsPerPage}
          onChange={(e) => onItemsPerPageChange(Number(e.target.value))}
          className="w-full px-4 py-2 rounded-[10px] border-[1.5px] border-[#D9D9D9] font-lexend font-medium text-sm text-[#180149] bg-white appearance-none cursor-pointer focus:outline-none focus:ring-0"
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#737373] pointer-events-none" aria-hidden="true" />
      </div>

      <p className="font-lexend font-medium text-[#737373] text-base whitespace-nowrap">
        {t('common.pageRange', { start: startIndex + 1, end: endIndex, total: totalItems })}
      </p>

      <div className="flex items-center gap-2">
        <button
          onClick={onPrevPage}
          disabled={currentPage === 1}
          className="p-2 rounded-lg border-[1.5px] border-[#D9D9D9] bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label={t('common.previousPage')}
        >
          <ChevronLeft className="w-5 h-5 text-[#737373]" aria-hidden="true" />
        </button>
        <button
          onClick={onNextPage}
          disabled={currentPage === totalPages}
          className="p-2 rounded-lg border-[1.5px] border-[#D9D9D9] bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label={t('common.nextPage')}
        >
          <ChevronRight className="w-5 h-5 text-[#737373]" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
