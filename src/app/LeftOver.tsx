import type { Unit } from "../domain/units";
import { leftOverPlaceholder, leftOverSuffix } from "./leftover-field";

/**
 * « Il en reste » (spec §6.5 stock.partial, §10.1): what is left, optional, and « Presque fini ». The item's unit stands
 * after the field, so a bare number is read in it (`leftOverWords`); an item with none shows nothing there.
 */
export function LeftOver({ id, text, low, unit, onText, onLow }: {
  id: string; text: string; low: boolean; unit: Unit | null; onText: (text: string) => void; onLow: (low: boolean) => void;
}) {
  const suffix = leftOverSuffix(unit, text);
  return (
    <div class="left-over">
      <label for={id}>Ce qu'il en reste (facultatif)</label>
      <div class="left-over-amount">
        <input id={id} type="text" autocomplete="off" placeholder={leftOverPlaceholder(unit)} value={text} onInput={(e) => onText(e.currentTarget.value)} />
        {suffix !== "" && <span class="left-over-unit">{suffix}</span>}
      </div>
      <label class="check">
        <input type="checkbox" checked={low} onChange={(e) => onLow(e.currentTarget.checked)} />
        Presque fini
      </label>
    </div>
  );
}
