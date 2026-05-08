import { useSyncExternalStore } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();

let selectedDisplaySetInstanceUIDs: string[] = [];

function emit(): void {
  listeners.forEach(l => l());
}

export function getSegMergeSelectionSnapshot(): string[] {
  return selectedDisplaySetInstanceUIDs;
}

export function subscribeSegMergeSelection(onStoreChange: Listener): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/**
 * Toggle selection for merge (max two SEG display sets). Third selection drops the first.
 */
export function toggleSegMergeDisplaySet(displaySetInstanceUID: string): void {
  const i = selectedDisplaySetInstanceUIDs.indexOf(displaySetInstanceUID);
  if (i >= 0) {
    selectedDisplaySetInstanceUIDs = selectedDisplaySetInstanceUIDs.filter((_, j) => j !== i);
  } else if (selectedDisplaySetInstanceUIDs.length < 2) {
    selectedDisplaySetInstanceUIDs = [...selectedDisplaySetInstanceUIDs, displaySetInstanceUID];
  } else {
    selectedDisplaySetInstanceUIDs = [selectedDisplaySetInstanceUIDs[1], displaySetInstanceUID];
  }
  emit();
}

export function clearSegMergeSelection(): void {
  if (selectedDisplaySetInstanceUIDs.length) {
    selectedDisplaySetInstanceUIDs = [];
    emit();
  }
}

export function useSegMergeSelection(): string[] {
  return useSyncExternalStore(
    subscribeSegMergeSelection,
    getSegMergeSelectionSnapshot,
    getSegMergeSelectionSnapshot
  );
}
