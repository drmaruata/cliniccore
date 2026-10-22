/**
 * The list surface every ClinicCore feature renders its rows through.
 *
 * It exists to make three decisions once rather than per feature: how a table looks while
 * loading, how it looks when the query succeeded and found nothing, and how a row is
 * keyed. Each of those is a place where features otherwise diverge, and the "empty but
 * successful" case in particular is the one most often rendered as a silent blank panel.
 *
 * COLOUR. None of its own. It composes the generated `ui/table` primitives, whose rules
 * are written entirely in terms of tokens (`border-border`, `bg-muted/50`,
 * `text-muted-foreground`), and delegates the empty state to `EmptyState`. There is no
 * `dark:` variant anywhere in this file, which is the visible proof that the token layer
 * is doing its job.
 *
 * SERVER/CLIENT. This component deliberately has no `"use client"`. It evaluates
 * `column.cell(row)` during its own render and passes the resulting nodes down to the
 * client `ui/table` primitives, so a server-rendered page can use it and no render
 * callback ever has to cross the RSC boundary. That rules out interactivity inside a
 * cell - put a `Button` or a menu in the cell content, not an inline event handler.
 *
 * MONEY. Cells render whatever the caller produced. Money stays bigint minor units in
 * the data layer and arrives here already formatted; this component performs no
 * arithmetic.
 */
import type * as React from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils/cn";

export interface DataTableColumn<T> {
  /** Stable identity for the column. Used as a React key and for testing. */
  key: string;
  /** Column heading content. */
  header: React.ReactNode;
  /** Renders one cell. Evaluated on the server for a server-rendered table. */
  cell: (row: T) => React.ReactNode;
  /** `right` for figures and dates, `left` for names and labels. */
  align?: "left" | "right";
  /** Extra classes for this column's cells. */
  cellClassName?: string;
}

export interface DataTableProps<T> extends Omit<React.ComponentProps<"div">, "children"> {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: readonly T[];
  /** Row identity. Must be stable across re-fetches or React will remount rows. */
  getRowKey: (row: T, index: number) => string;
  /** Accessible caption. Also renders visibly, so make it useful. */
  caption?: React.ReactNode;
  /** Replaces the default empty state entirely. */
  empty?: React.ReactNode;
  /** Default empty-state copy, used when `empty` is not supplied. */
  emptyTitle?: React.ReactNode;
  emptyDescription?: React.ReactNode;
  /** Draws placeholder rows instead of data. */
  loading?: boolean;
  /** Placeholder row count while `loading`. */
  loadingRows?: number;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  caption,
  empty,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  loading = false,
  loadingRows = 5,
  className,
  ...props
}: DataTableProps<T>) {
  const showEmpty = !loading && rows.length === 0;

  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      {showEmpty ? (
        (empty ?? <EmptyState title={emptyTitle} description={emptyDescription} />)
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  key={column.key}
                  scope="col"
                  className={column.align === "right" ? "text-right" : undefined}
                >
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: Math.max(0, loadingRows) }, (_, index) => (
                  <TableRow key={`loading-${index}`}>
                    {columns.map((column) => (
                      <TableCell key={column.key}>
                        <Skeleton size="line" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row, index) => (
                  <TableRow key={getRowKey(row, index)}>
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(
                          column.align === "right" && "text-right tabular-nums",
                          column.cellClassName,
                        )}
                      >
                        {column.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
          </TableBody>
          {caption !== undefined && <TableCaption>{caption}</TableCaption>}
        </Table>
      )}
    </div>
  );
}
