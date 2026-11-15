import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import type { PublicStatus, rpcContract } from "./server";
import type { Choices, Conflict } from "./src/model";

function display(value: unknown, present: boolean) {
  if (!present) return "По умолчанию / не задано";
  if (value === null) return "Отключено";
  if (typeof value === "boolean") return value ? "Включено" : "Выключено";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
const time = (value: string) => new Date(value).toLocaleString();
function ConflictRow({
  conflict,
  selected,
  choose,
}: {
  conflict: Conflict;
  selected?: "local" | "remote";
  choose: (side: "local" | "remote") => void;
}) {
  return (
    <fieldset className="space-y-3 border-t border-border py-4">
      <legend className="max-w-full break-all px-1 pt-3 text-sm font-medium">
        {conflict.key}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["local", "remote"] as const).map((side) => (
          <label
            key={side}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${selected === side ? "border-primary bg-accent" : "border-border"}`}
          >
            <input
              type="radio"
              name={conflict.key}
              checked={selected === side}
              onChange={() => choose(side)}
              className="mt-1 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {side === "local" ? "Этот ноутбук" : "GitHub"}
              </span>
              <span className="mt-1 block max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                {display(conflict[side], conflict[`${side}Present`])}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SyncPage() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const [data, setData] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selection, setSelection] = useState<{
    planId: string | null;
    choices: Choices;
  }>({ planId: null, choices: {} });
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await rpc.call("status");
      if (mounted.current && id === requestId.current) setData(next);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Не удалось получить статус",
        );
    }
  }, [rpc]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useRealtime("changed", () => {
    void refresh();
  });
  useEffect(() => {
    if (
      connection === "connected" &&
      previousConnection.current !== "connected"
    )
      void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);
  const planId = data?.status?.planId;
  const choices = selection.planId === planId ? selection.choices : {};
  const setChoices = (next: Choices | ((prev: Choices) => Choices)) =>
    setSelection({
      planId: planId ?? null,
      choices: typeof next === "function" ? next(choices) : next,
    });
  async function run(action: "sync" | "restore" | "resolve") {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result =
        action === "resolve"
          ? await rpc.call("resolve", { planId: planId!, choices })
          : await rpc.call(action);
      if (mounted.current) {
        ++requestId.current;
        setData(result);
        setRestoreConfirm(false);
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Операция не удалась",
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  const status = data?.status;
  const busy = pending || status?.phase === "syncing";
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">bb-sync</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Настройки bb на всех твоих ноутбуках.
            </p>
          </div>
          <Button
            disabled={busy || !data?.configured}
            onClick={() => void run("sync")}
          >
            {busy ? "Синхронизация…" : "Синхронизировать"}
          </Button>
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Загрузка…
          </p>
        ) : (
          <>
            {!data.configured ? (
              <section className="space-y-3 rounded-lg border border-border p-5">
                <h2 className="font-medium">Подключи GitHub</h2>
                <p className="text-sm text-muted-foreground">
                  В настройках плагина укажи приватный репозиторий с
                  существующей веткой и GitHub token с правом Contents: read and
                  write. На каждом ноутбуке выбери один и тот же репозиторий,
                  ветку и файл.
                </p>
                <p className="text-sm text-muted-foreground">
                  Репозиторий с личными настройками создаётся отдельно от
                  репозитория с кодом плагина.
                </p>
                <p role="status" className="break-words text-sm">
                  {data.configurationError}
                </p>
              </section>
            ) : (
              <section
                className="space-y-3 rounded-lg border border-border p-5"
                aria-live="polite"
              >
                <p
                  className={`font-medium ${status?.phase === "error" || status?.phase === "recovery" ? "text-destructive" : ""}`}
                >
                  {status?.message}
                </p>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Репозиторий</dt>
                    <dd className="break-all">{data.repository}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Автосинхронизация</dt>
                    <dd>{data.enabled ? "Включена" : "Приостановлена"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      Последняя синхронизация
                    </dt>
                    <dd>
                      {status?.lastSync
                        ? time(status.lastSync)
                        : "Ещё не выполнялась"}
                    </dd>
                  </div>
                </dl>
              </section>
            )}
            {status?.conflicts.length ? (
              <section>
                <h2 className="font-medium">Выбери значения</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Независимые изменения объединятся автоматически. Пока выбор не
                  закончен, настройки не применяются.
                </p>
                <div className="my-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setChoices(
                        Object.fromEntries(
                          status.conflicts.map((c) => [c.key, "local"]),
                        ),
                      )
                    }
                  >
                    Все с этого ноутбука
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setChoices(
                        Object.fromEntries(
                          status.conflicts.map((c) => [c.key, "remote"]),
                        ),
                      )
                    }
                  >
                    Все из GitHub
                  </Button>
                </div>
                {status.conflicts.map((c) => (
                  <ConflictRow
                    key={c.key}
                    conflict={c}
                    selected={choices[c.key]}
                    choose={(side) =>
                      setChoices((prev) => ({ ...prev, [c.key]: side }))
                    }
                  />
                ))}
                <Button
                  disabled={
                    busy || status.conflicts.some((c) => !choices[c.key])
                  }
                  onClick={() => void run("resolve")}
                >
                  Применить выбор
                </Button>
              </section>
            ) : null}
            {status?.unsupported.length ? (
              <details className="text-sm">
                <summary className="cursor-pointer">
                  Не применяются на этом ноутбуке ({status.unsupported.length})
                </summary>
                <p className="my-2 text-muted-foreground">
                  Поля выключенных групп и неизвестные настройки сохраняются в
                  GitHub. Настройки новых версий и отсутствующих плагинов
                  локально не применяются.
                </p>
                <ul className="space-y-1">
                  {status.unsupported.map((key) => (
                    <li key={key} className="break-all font-mono text-xs">
                      {key}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {status?.backupAt && (
              <section className="space-y-3 border-t border-border pt-5">
                <h2 className="font-medium">Локальный снимок</h2>
                <p className="text-sm text-muted-foreground">
                  Сохранён {time(status.backupAt)} перед последним применением.
                  Восстановление изменит настройки этого bb и приостановит
                  автосинхронизацию.
                </p>
                {restoreConfirm ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy}
                      variant="destructive"
                      onClick={() => void run("restore")}
                    >
                      Восстановить и приостановить
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRestoreConfirm(false)}
                    >
                      Отмена
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setRestoreConfirm(true)}
                  >
                    Восстановить снимок
                  </Button>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sync",
    path: "sync",
    title: "bb-sync",
    icon: "RefreshCw",
    component: SyncPage,
  });
  app.slots.settingsSection({
    id: "sync-status",
    title: "Синхронизация",
    component: SyncPage,
  });
});
