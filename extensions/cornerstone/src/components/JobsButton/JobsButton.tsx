import React, { useEffect, useState } from 'react';
import { useSystem } from '@ohif/core';
import { Button, Icons, Popover, PopoverTrigger, PopoverContent } from '@ohif/ui-next';
import { getFunctionsBaseUrl } from '../../../../../platform/app/src/utils/buildFunctionUrl';

const PAGE_SIZE = 5;
// While the popover is open, re-fetch to keep in-progress stage bars live.
const POLL_INTERVAL_MS = 5000;

const CONVERT_OPERATION_NAMES = new Set(['ExportToGlasses', 'DownloadObj']);

interface Operation {
  operation_id: string;
  operation_name: string;
  task_name: string;
  study_id: string;
  series_id: string;
  status: string | null;
  created_at: string;
  stage?: number | null;
  stage_count?: number | null;
  stage_label?: string | null;
  result_url?: string | null;
  result_path?: string | null;
}

function StageBar({
  stage,
  stageCount,
  stageLabel,
}: {
  stage: number;
  stageCount: number;
  stageLabel?: string | null;
}) {
  return (
    <div className="mt-1">
      <div className="flex gap-0.5">
        {Array.from({ length: stageCount }, (_, i) => i + 1).map(i => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-sm ${
              i < stage ? 'bg-primary-light' : i === stage ? 'bg-primary-main' : 'bg-black'
            }`}
          />
        ))}
      </div>
      {stageLabel ? (
        <div className="mt-0.5 text-center text-[10px] text-white">{stageLabel}</div>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  InQueue: 'In Queue',
  InProgress: 'In Progress',
  Completed: 'Completed',
  Failed: 'Failed',
};

const STATUS_COLOR: Record<string, string> = {
  InQueue: 'text-yellow-400',
  InProgress: 'text-blue-400',
  Completed: 'text-green-400',
  Failed: 'text-red-400',
};

function isCancellable(operation: Operation): boolean {
  return operation.status === 'InQueue' || operation.status === 'InProgress';
}

function OperationRow({
  operation,
  onCancel,
  cancelling,
}: {
  operation: Operation;
  onCancel?: (operation: Operation) => void;
  cancelling?: boolean;
}) {
  const status = operation.status ?? 'Unknown';
  const label = STATUS_LABEL[status] ?? status;
  const color = STATUS_COLOR[status] ?? 'text-white/50';
  const name = operation.task_name
    ? `${operation.operation_name} (${operation.task_name})`
    : operation.operation_name;

  const studyUrl = `${window.location.origin}/segmentation?StudyInstanceUIDs=${operation.study_id}`;
  const canCancel = Boolean(onCancel) && isCancellable(operation);

  return (
    <div className="flex items-start gap-2 border-b border-white/10 py-2 last:border-0">
      <div className="mt-0.5 shrink-0">
        <Icons.StatusTracking className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">{name}</div>
        <a
          href={studyUrl}
          className="truncate text-xs text-blue-400 underline hover:text-white"
          title={operation.study_id}
          onClick={e => {
            e.preventDefault();
            window.location.href = studyUrl;
          }}
        >
          Study: …{operation.study_id?.slice(-12)}
        </a>
        <div
          className="text-muted-foreground truncate text-xs"
          title={operation.series_id}
        >
          Series: …{operation.series_id?.slice(-12)}
        </div>
        {status === 'InProgress' && operation.stage_count ? (
          <StageBar
            stage={operation.stage ?? 0}
            stageCount={operation.stage_count}
            stageLabel={operation.stage_label}
          />
        ) : null}
        {status === 'Completed' && operation.result_url ? (
          <a
            href={operation.result_url}
            className="mt-1 inline-block text-xs text-blue-400 underline hover:text-white"
            target="_blank"
            rel="noopener noreferrer"
          >
            Download result
          </a>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            className="mt-1 text-xs text-red-400 underline hover:text-white disabled:opacity-50"
            disabled={cancelling}
            onClick={() => onCancel?.(operation)}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
      </div>
      <div className={`shrink-0 text-xs font-semibold ${color}`}>{label}</div>
    </div>
  );
}

export function JobsButton() {
  const { extensionManager, servicesManager } = useSystem() as {
    extensionManager: any;
    servicesManager?: { services?: { uiNotificationService?: any } };
  };
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  const notify = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    servicesManager?.services?.uiNotificationService?.show?.({
      title: type === 'error' ? 'Operations' : 'Operations',
      message,
      type,
      duration: 4000,
    });
  };

  const getAuthAndBase = () => {
    const [ds] = extensionManager?.getActiveDataSource?.() ?? [];
    if (!ds) {
      return null;
    }
    const config = ds.getConfig?.() ?? {};
    const baseUrl = getFunctionsBaseUrl(config);
    if (!baseUrl) {
      return null;
    }
    const bearer = ds?.retrieve?.customClient?.headers?.Authorization;
    const headers = bearer ? { Authorization: bearer } : {};
    return { baseUrl, headers };
  };

  const fetchOperations = async () => {
    try {
      setLoading(true);
      const ctx = getAuthAndBase();
      if (!ctx) {
        return;
      }

      const response = await fetch(`${ctx.baseUrl}/GetOperations`, { headers: ctx.headers });
      if (!response.ok) {
        return;
      }
      const data: Operation[] = await response.json();
      data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setOperations(data);
      setPage(0);
    } catch (e) {
      console.error('Failed to fetch operations:', e);
    } finally {
      setLoading(false);
    }
  };

  const clearStuckConvertOps = async () => {
    const ctx = getAuthAndBase();
    if (!ctx) {
      return;
    }
    try {
      setClearing(true);
      const response = await fetch(`${ctx.baseUrl}/CancelStuckOperations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...ctx.headers,
        },
        body: JSON.stringify({
          operationNames: ['ExportToGlasses', 'DownloadObj'],
          clearConvertQueue: true,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(text || `Status ${response.status}`);
      }
      const payload = await response.json().catch(() => ({}));
      const count = payload.cancelledCount ?? 0;
      notify(
        count
          ? `Cleared ${count} stuck export/download operation(s).`
          : 'No stuck export/download operations found.',
        'success'
      );
      await fetchOperations();
    } catch (e: any) {
      console.error('Failed to clear stuck operations:', e);
      notify(e?.message || 'Failed to clear stuck operations', 'error');
    } finally {
      setClearing(false);
    }
  };

  const cancelOne = async (operation: Operation) => {
    const ctx = getAuthAndBase();
    if (!ctx) {
      return;
    }
    try {
      setCancellingId(operation.operation_id);
      const response = await fetch(`${ctx.baseUrl}/CancelStuckOperations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...ctx.headers,
        },
        body: JSON.stringify({
          operationId: operation.operation_id,
          operationName: operation.operation_name,
          clearConvertQueue: CONVERT_OPERATION_NAMES.has(operation.operation_name),
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(text || `Status ${response.status}`);
      }
      notify(`Cancelled ${operation.operation_name}`, 'success');
      await fetchOperations();
    } catch (e: any) {
      console.error('Failed to cancel operation:', e);
      notify(e?.message || 'Failed to cancel operation', 'error');
    } finally {
      setCancellingId(null);
    }
  };

  const stuckConvertCount =
    operations?.filter(
      op => CONVERT_OPERATION_NAMES.has(op.operation_name) && isCancellable(op)
    ).length ?? 0;

  const totalPages = Math.ceil((operations?.length ?? 0) / PAGE_SIZE);
  const paginated = operations?.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) ?? [];

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const interval = setInterval(fetchOperations, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isOpen]);

  return (
    <Popover
      onOpenChange={open => {
        setIsOpen(open);
        if (open) {
          fetchOperations();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="hover:bg-primary-dark"
          title="Operations"
        >
          <Icons.ListView className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 p-0"
      >
        <div className="bg-primary-dark rounded-md p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-white">Operations</span>
            <button
              className="text-muted-foreground text-xs hover:text-white"
              onClick={fetchOperations}
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {stuckConvertCount > 0 ? (
            <button
              type="button"
              className="mb-3 w-full rounded border border-yellow-500/60 bg-yellow-500/10 px-2 py-1.5 text-xs font-medium text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-50"
              onClick={clearStuckConvertOps}
              disabled={clearing}
              title="Cancel stuck ExportToGlasses / DownloadObj and clear convert-tasks queue"
            >
              {clearing
                ? 'Clearing stuck exports…'
                : `Clear stuck exports (${stuckConvertCount})`}
            </button>
          ) : null}

          {loading && operations === null ? (
            <div className="text-muted-foreground py-4 text-center text-sm">Loading…</div>
          ) : !operations?.length ? (
            <div className="text-muted-foreground py-4 text-center text-sm">No operations yet</div>
          ) : (
            <>
              <div>
                {paginated.map(op => (
                  <OperationRow
                    key={op.operation_id}
                    operation={op}
                    onCancel={cancelOne}
                    cancelling={cancellingId === op.operation_id}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-2 flex items-center justify-between">
                  <button
                    className="text-muted-foreground text-xs hover:text-white disabled:opacity-30"
                    onClick={() => setPage(p => p - 1)}
                    disabled={page === 0}
                  >
                    ← Prev
                  </button>
                  <span className="text-muted-foreground text-xs">
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    className="text-muted-foreground text-xs hover:text-white disabled:opacity-30"
                    onClick={() => setPage(p => p + 1)}
                    disabled={page >= totalPages - 1}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default JobsButton;
