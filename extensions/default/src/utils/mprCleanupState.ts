export type MprCleanupPhase = 'idle' | 'collecting' | 'confirming' | 'deleting';

let phase: MprCleanupPhase = 'idle';
type MprCleanupProgress = {
  batchFrom: number;
  batchTo: number;
  total: number;
} | null;

let progress: MprCleanupProgress = null;
const listeners = new Set<() => void>();

export const getMprCleanupPhase = (): MprCleanupPhase => phase;
export const getMprCleanupProgress = (): MprCleanupProgress => progress;

/** Combined snapshot so UI re-renders when progress changes while phase stays `deleting`. */
export const getMprCleanupSnapshot = (): string => {
  const p = progress;
  const progressKey = p ? `${p.batchFrom}-${p.batchTo}-${p.total}` : '';
  return `${phase}|${progressKey}`;
};

export const isMprCleanupInFlight = (): boolean => phase !== 'idle';

export const setMprCleanupPhase = (next: MprCleanupPhase): void => {
  if (phase === next) {
    return;
  }
  phase = next;
  listeners.forEach(listener => listener());
};

export const setMprCleanupProgress = (next: MprCleanupProgress): void => {
  const same =
    progress?.batchFrom === next?.batchFrom &&
    progress?.batchTo === next?.batchTo &&
    progress?.total === next?.total;
  if (same) {
    return;
  }
  progress = next;
  listeners.forEach(listener => listener());
};

export const subscribeMprCleanup = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
