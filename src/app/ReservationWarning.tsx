import type { Resolution } from "../domain/ops/helpers";
import type { ResteItem } from "../domain/snapshot";
import { reservedFor } from "./format";
import { canRebuy } from "./sync/project";

/**
 * Spec §10.4, before a « Fini » on an item an open meal holds: « Réservé pour Salade d'endives », then « Retirer le
 * repas », « Racheter » and « Annuler ». « Racheter » is not offered for a plat cuisiné, which the server refuses to
 * buy back (helpers.ts `settleReservations`). It sends nothing: the caller sends its op with the resolution chosen.
 */
export function ReservationWarning({ holding, onChoose, onCancel }: {
  holding: ResteItem["reservations"];
  onChoose: (resolution: Resolution) => void;
  onCancel: () => void;
}) {
  const rebuy = canRebuy(holding);
  return (
    <div class="warning" role="group" aria-label={reservedFor(holding.map((h) => h.mealTitle))}>
      <p class="warning-title">{reservedFor(holding.map((h) => h.mealTitle))}</p>
      <p class="meta">
        {rebuy ? "Fini, il manquera à ce repas : retirez-le du menu, ou rachetez ce qu'il lui faut." : "Un plat cuisiné ne se rachète pas : fini, son repas est retiré du menu."}
      </p>
      <div class="actions">
        <button type="button" class="button" onClick={() => onChoose("drop_meal")}>Retirer le repas</button>
        {rebuy && <button type="button" class="button" onClick={() => onChoose("rebuy")}>Racheter</button>}
        <button type="button" class="link" onClick={onCancel}>Annuler</button>
      </div>
    </div>
  );
}
