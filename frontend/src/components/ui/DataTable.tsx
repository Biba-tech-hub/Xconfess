import React, { useCallback, useId, useMemo, useState } from 'react';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'center' | 'right';
}

export interface DataTableRowAction<T> {
  key: string;
  label: string | ((row: T) => string);
  onSelect: (row: T) => void;
  disabled?: (row: T) => boolean;
}

export interface DataTableProps<T> {
  caption: string;
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  rowActions?: DataTableRowAction<T>[];
  page?: number;
  pageSize?: number;
  totalCount?: number;
  onPageChange?: (page: number) => void;
  emptyMessage?: string;
}

type SortDirection = 'ascending' | 'descending';

interface SortState {
  key: string;
  direction: SortDirection;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  getRowId,
  rowActions = [],
  page = 1,
  pageSize,
  totalCount,
  onPageChange,
  emptyMessage = 'No records found.',
}: DataTableProps<T>) {
  const captionId = useId();
  const [sort, setSort] = useState<SortState | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const result = compareValues(
        (a as Record<string, unknown>)[sort.key],
        (b as Record<string, unknown>)[sort.key],
      );
      return sort.direction === 'ascending' ? result : -result;
    });
    return copy;
  }, [rows, columns, sort]);

  const handleSort = useCallback(
    (column: DataTableColumn<T>) => {
      if (!column.sortable) return;
      setSort((current) => {
        const nextDirection: SortDirection =
          current && current.key === column.key && current.direction === 'ascending'
            ? 'descending'
            : 'ascending';
        setAnnouncement(
          `Sorted by ${column.header}, ${nextDirection === 'ascending' ? 'ascending' : 'descending'}`,
        );
        return { key: column.key, direction: nextDirection };
      });
    },
    [],
  );

  const resolvedTotal = totalCount ?? sortedRows.length;
  const resolvedPageSize = pageSize ?? sortedRows.length || 1;
  const totalPages = Math.max(1, Math.ceil(resolvedTotal / resolvedPageSize));
  const hasPagination = Boolean(onPageChange) && totalPages > 1;

  const goToPage = useCallback(
    (nextPage: number) => {
      if (!onPageChange) return;
      const clamped = Math.min(Math.max(nextPage, 1), totalPages);
      if (clamped === page) return;
      onPageChange(clamped);
      setAnnouncement(`Page ${clamped} of ${totalPages}`);
    },
    [onPageChange, page, totalPages],
  );

  return (
    <div className="data-table">
      <table aria-labelledby={captionId}>
        <caption id={captionId}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sort?.key === column.key;
              const ariaSort = isSorted ? sort?.direction : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={column.sortable ? ariaSort ?? 'none' : undefined}
                  style={{ textAlign: column.align ?? 'left' }}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className="data-table__sort"
                      onClick={() => handleSort(column)}
                      aria-label={`Sort by ${column.header}${
                        isSorted
                          ? `, currently ${sort?.direction}`
                          : ''
                      }`}
                    >
                      {column.header}
                      <span aria-hidden="true" className="data-table__sort-indicator">
                        {isSorted ? (sort?.direction === 'ascending' ? '\u25B2' : '\u25BC') : '\u21C5'}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
            {rowActions.length > 0 && (
              <th scope="col" className="data-table__actions-header">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (rowActions.length > 0 ? 1 : 0)}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => {
              const rowId = getRowId(row);
              return (
                <tr key={rowId}>
                  {columns.map((column) => (
                    <td key={column.key} style={{ textAlign: column.align ?? 'left' }}>
                      {column.render
                        ? column.render(row)
                        : String((row as Record<string, unknown>)[column.key] ?? '')}
                    </td>
                  ))}
                  {rowActions.length > 0 && (
                    <td className="data-table__actions">
                      {rowActions.map((action) => {
                        const label =
                          typeof action.label === 'function' ? action.label(row) : action.label;
                        const disabled = action.disabled ? action.disabled(row) : false;
                        return (
                          <button
                            key={action.key}
                            type="button"
                            className="data-table__action"
                            onClick={() => action.onSelect(row)}
                            disabled={disabled}
                            aria-label={`${label} for row ${rowId}`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </td>
                  )}
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {hasPagination && (
        <nav className="data-table__pagination" aria-label={`${caption} pagination`}>
          <button
            type="button"
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            Previous
          </button>
          <span aria-live="polite">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => goToPage(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            Next
          </button>
        </nav>
      )}

      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

export default DataTable;
