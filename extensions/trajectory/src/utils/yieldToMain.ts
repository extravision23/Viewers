/** Yield control back to the browser event loop so the UI can repaint. */
export function yieldToMain(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
