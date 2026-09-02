/**
 * Renderer-side script for the pairing approval window (`pairing-approval.html`).
 * Kept tiny and dependency-free so it ships inside the strict-CSP page
 * (`script-src 'self'`, no inline). Talks back to the main process only
 * through `window.pairingApproval.decide` (`src/main/pairing-preload.ts`),
 * never a raw `ipcRenderer`.
 *
 * Runs in a plain (non-Node) renderer, hence the explicit `dom` lib reference
 * rather than pulling `dom` into the whole package's (Node-targeted) tsconfig.
 */
/// <reference lib="dom" />

interface PairingApprovalApi {
  decide(approved: boolean): void;
}
declare const window: Window & { pairingApproval?: PairingApprovalApi };

document.getElementById("approve")?.addEventListener("click", () => {
  window.pairingApproval?.decide(true);
});
document.getElementById("deny")?.addEventListener("click", () => {
  window.pairingApproval?.decide(false);
});

const deadlineAttr = document.body.dataset["deadline"];
const countdownEl = document.getElementById("countdown");
if (deadlineAttr && countdownEl) {
  const deadline = new Date(deadlineAttr).getTime();
  const tick = (): void => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    countdownEl.textContent = String(remaining);
    if (remaining <= 0) clearInterval(timer);
  };
  const timer = setInterval(tick, 1000);
  tick();
}
