import { TablePagination } from '@presentation/components/molecules/TablePagination';

interface AreaPeoplePaginationProps {
  page: number;
  perPage: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onPerPage: (value: number) => void;
}

/**
 * O `TablePagination` da casa. O desenho lê o intervalo em #374151 e a seta do seletor em #737373 (o do
 * molecule é #737373 e `gray-400` = #ECEFF1, quase invisível): ajuste por seletor, SÓ aqui — o molecule
 * é compartilhado e não muda.
 */
export function AreaPeoplePagination({ page, perPage, total, onPrev, onNext, onPerPage }: AreaPeoplePaginationProps): JSX.Element {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return (
    <div data-testid="pagination" className="[&_p]:!text-[#374151]">
      <TablePagination
        currentPage={page}
        totalPages={pages}
        totalItems={total}
        itemsPerPage={perPage}
        startIndex={start}
        endIndex={Math.min(total, start + perPage)}
        onPrevPage={onPrev}
        onNextPage={onNext}
        onItemsPerPageChange={onPerPage}
      />
    </div>
  );
}
