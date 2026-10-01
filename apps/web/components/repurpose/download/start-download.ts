/**
 * Sends the browser to a download (2026-10-01). The answer is an attachment,
 * so the page stays where it is and the browser shows the file's progress.
 * On its own so a test can see the address without a real navigation.
 */
export function startDownload(url: string): void {
  window.location.assign(url);
}
