import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * A modal sheet docked at the bottom. It is a route (`#/courses/caisse`): « Fermer », Échap and the back button all
 * close it, and the rest of the page is inert while it is open. It opens on its title, not on « Fermer »: showModal()
 * focuses the first control otherwise, where a browser that shows focus after a tap draws a ring.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const closed = () => onClose();
    dialog.addEventListener("close", closed);
    return () => dialog.removeEventListener("close", closed);
  }, []);
  return (
    <dialog ref={ref} class="sheet" aria-labelledby="sheet-title">
      <div class="sheet-head">
        <h2 id="sheet-title" tabIndex={-1} autofocus>{title}</h2>
        <button type="button" class="link" onClick={() => ref.current?.close()}>Fermer</button>
      </div>
      {children}
    </dialog>
  );
}
