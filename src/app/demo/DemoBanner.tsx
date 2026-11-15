/** Above the status lines on every screen of the demo: what this is, and the way back to the first state. */
export function DemoBanner({ onReset }: { onReset: () => void }) {
  return (
    <p class="status-line">
      Démo — données fictives.
      <button type="button" class="link" onClick={onReset}>Réinitialiser</button>
    </p>
  );
}
