import type { ComponentChildren } from "preact";
import { droppedSheetLine, refusalLine, statusLine } from "./format";
import type { Sync, SyncState } from "./sync/sync";

/** Through Access again: the service worker lets this navigation reach the network (sw-logic.ts); main.tsx drops the marker. */
function reconnect(): void {
  location.assign(`/?reconnexion=1${location.hash}`);
}

/**
 * The lines under the field (spec §8.3): the banner when there is one (the demo's), a new version, what waits and why, what failed, what was refused, a Cuisiné sheet
 * the other phone's cook made the server drop (outbox.ts `sheetDropped`). Nothing when synced.
 */
export function StatusLines({ state, sync, updateReady, onUpdate, banner }: { state: SyncState; sync: Sync; updateReady: boolean; onUpdate: () => void; banner?: ComponentChildren }) {
  const waiting = statusLine(state.status, state.waitingCount);
  return (
    <div class="status" aria-live="polite">
      {banner}
      {updateReady && (
        <p class="status-line">
          Nouvelle version de l'app.
          <button type="button" class="link" onClick={onUpdate}>Mettre à jour</button>
        </p>
      )}
      {waiting !== null && (
        <p class="status-line muted">
          {waiting}
          {/* the demo has no Access to go back through */}
          {!__LA_TABLE_DEMO__ && state.status === "reauth" && <button type="button" class="link" onClick={reconnect}>Se reconnecter</button>}
        </p>
      )}
      {state.failed.map((e) => (
        <p class="status-line" key={e.op.opId}>
          En échec : {e.label}{e.lastReason ? ` (${e.lastReason})` : ""}.
          <button type="button" class="link" onClick={() => void sync.retry(e.op.opId)}>Réessayer</button>
          <button type="button" class="link" onClick={() => void sync.abandon(e.op.opId)}>Abandonner</button>
        </p>
      ))}
      {state.refusals.length > 0 && (
        <p class="status-line">
          {refusalLine(state.refusals)}
          <button type="button" class="link" onClick={() => sync.dismissRefusals()}>OK</button>
        </p>
      )}
      {state.droppedSheets.length > 0 && (
        <p class="status-line">
          {droppedSheetLine(state.droppedSheets)}
          <button type="button" class="link" onClick={() => sync.dismissDroppedSheets()}>OK</button>
        </p>
      )}
      {!state.persistent && (
        <p class="status-line muted">Stockage local indisponible : une action faite hors ligne est perdue si l'app se ferme.</p>
      )}
    </div>
  );
}
