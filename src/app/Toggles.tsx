/**
 * Choices of which one at most is on, all of them optional (spec §10.1: « Everything optional »): a tap turns one on,
 * a tap on the one that is on turns it off. Pressed, it is filled with ink like a ticked box: no colour (DESIGN.md).
 */
export function Toggles<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  return (
    <div class="toggles" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" class="toggle" aria-pressed={value === o.value} onClick={() => onChange(value === o.value ? null : o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
