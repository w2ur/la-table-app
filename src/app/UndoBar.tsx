import { useEffect } from "preact/hooks";

/** Spec §10.5: every tick shows « Annuler » for 5 s. */
export const UNDO_MS = 5000;

export function UndoBar({ label, onUndo, onExpire }: { label: string; onUndo: () => void; onExpire: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onExpire, UNDO_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div class="undo-bar" role="status">
      <span>{label}</span>
      <button type="button" onClick={onUndo}>Annuler</button>
    </div>
  );
}
