import { Button } from "../components/ui/button";
import { displayValue, settingLabel } from "../src/labels";
import type { Choices, Conflict } from "../src/model";
export const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText)
    throw new Error("Копирование недоступно в этом браузере.");
  await navigator.clipboard.writeText(text);
}
export function Failure({
  message,
  retry,
}: {
  message: string | null;
  retry?: () => void;
}) {
  if (!message) return null;
  return (
    <div role="alert" className="border-l-2 border-destructive pl-3 text-sm">
      <p className="whitespace-pre-wrap break-words">{message}</p>
      {retry && (
        <Button variant="link" className="mt-1 h-auto px-0" onClick={retry}>
          Повторить
        </Button>
      )}
    </div>
  );
}
export const groups = [
  {
    key: "appearance",
    title: "Тема и оформление",
    detail: "Тема и цвет значка",
  },
  {
    key: "keyboard",
    title: "Горячие клавиши",
    detail: "Переназначения для каждой платформы",
  },
  {
    key: "interface",
    title: "Интерфейс",
    detail: "Навигация, видимые разделы и поведение bb",
  },
] as const;
export type Scope = {
  appearance: boolean;
  keyboard: boolean;
  interface: boolean;
};
export function ScopePicker({
  scope,
  onChange,
  disabled,
}: {
  scope: Scope;
  onChange: (scope: Scope) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-3 text-sm font-medium">Что синхронизировать</legend>
      {groups.map((group) => (
        <label
          key={group.key}
          className="flex cursor-pointer items-start gap-3 text-sm"
        >
          <input
            className="mt-1 accent-current"
            type="checkbox"
            checked={scope[group.key]}
            onChange={(e) =>
              onChange({ ...scope, [group.key]: e.target.checked })
            }
          />
          <span>
            <span className="block">{group.title}</span>
            <span className="text-xs text-muted-foreground">
              {group.detail}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
export function ConflictRow({
  conflict,
  selected,
  choose,
  disabled,
}: {
  conflict: Conflict;
  selected?: "local" | "remote";
  choose: (side: "local" | "remote") => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      disabled={disabled}
      className="space-y-3 border-t border-border py-4"
    >
      <legend className="max-w-full break-words pr-3 pt-3 text-sm font-medium">
        {settingLabel(conflict.key)}
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["local", "remote"] as const).map((side) => (
          <label
            key={side}
            className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors ${selected === side ? "border-foreground bg-accent" : "border-border hover:bg-accent/50"}`}
          >
            <input
              type="radio"
              name={conflict.key}
              checked={selected === side}
              onChange={() => choose(side)}
              className="mt-1 accent-current"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {side === "local" ? "Этот ноутбук" : "GitHub"}
              </span>
              <span className="mt-1 block max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {displayValue(conflict[side], conflict[`${side}Present`])}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export function QuickChoices({
  conflicts,
  select,
  disabled,
}: {
  conflicts: Conflict[];
  select: (choices: Choices) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() =>
          select(Object.fromEntries(conflicts.map((c) => [c.key, "remote"])))
        }
      >
        Все из GitHub
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() =>
          select(Object.fromEntries(conflicts.map((c) => [c.key, "local"])))
        }
      >
        Все с этого ноутбука
      </Button>
    </div>
  );
}
