import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import type { PublicStatus, rpcContract } from "./server";
import type { Choices } from "./src/model";
import { FirstTransfer, Setup } from "./ui/setup";
import {
  ConflictRow,
  copyText,
  Failure,
  groups,
  inputClass,
  QuickChoices,
  ScopePicker,
} from "./ui/shared";

function Preferences({
  current,
  save,
  busy,
}: {
  current: PublicStatus;
  save: (input: PublicStatus["options"]) => void;
  busy: boolean;
}) {
  const [scope, setScope] = useState({
    appearance: current.options.appearance,
    keyboard: current.options.keyboard,
    interface: current.options.interface,
    plugins: current.options.plugins,
  });
  const [interval, setInterval] = useState(current.options.intervalSeconds);
  const intervalId = useId();
  const changed =
    Object.entries(scope).some(
      ([key, value]) => current.options[key as keyof typeof scope] !== value,
    ) || interval !== current.options.intervalSeconds;
  return (
    <details className="border-t border-border pt-5">
      <summary className="cursor-pointer text-sm font-medium">
        Что переносится и как часто
      </summary>
      <div className="mt-5 space-y-5">
        <ScopePicker scope={scope} onChange={setScope} disabled={busy} />
        <div className="max-w-xs">
          <label htmlFor={intervalId} className="mb-2 block text-sm">
            Проверять изменения на других ноутбуках
          </label>
          <select
            id={intervalId}
            disabled={busy}
            className={inputClass}
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
          >
            {[
              ...new Set([
                30,
                60,
                120,
                300,
                600,
                current.options.intervalSeconds,
              ]),
            ]
              .sort((a, b) => a - b)
              .map((n) => (
                <option value={n} key={n}>
                  {n < 60 ? `${n} секунд` : `${n / 60} мин.`}
                </option>
              ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          При изменении состава настроек покажем сравнение перед переносом.
          Размеры окон, чаты и доступы остаются на каждом ноутбуке.
        </p>
        <Button
          variant="outline"
          disabled={busy || !changed || !Object.values(scope).some(Boolean)}
          onClick={() => save({ ...scope, intervalSeconds: interval })}
        >
          Сохранить
        </Button>
      </div>
    </details>
  );
}
function AnotherLaptop({ repository }: { repository: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const instruction = `Подключи этот ноутбук к Sync:\n1. Установи плагин: bb plugin install git:https://github.com/brudnyi/bb-sync.git@main\n2. Открой Sync и нажми «Подключить GitHub».\n3. Выбери существующее приватное хранилище ${repository}.\n4. Нажми «Использовать настройки из GitHub».\nНе копируй токены между ноутбуками — на каждом используется свой вход в GitHub.`;
  return (
    <details className="border-t border-border pt-5">
      <summary className="cursor-pointer text-sm font-medium">
        Подключить другой ноутбук
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        <p>
          Установи Sync на другом ноутбуке, подключи GitHub и выбери{" "}
          <strong className="break-all">{repository}</strong>. Затем примени
          настройки из GitHub.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              copyText(instruction).then(
                () => {
                  setCopied(true);
                  setCopyError(false);
                },
                () => setCopyError(true),
              );
            }}
          >
            {copied ? "Инструкция скопирована" : "Скопировать инструкцию"}
          </Button>
          <a
            className="inline-flex items-center px-2 text-sm underline underline-offset-4"
            href="https://github.com/brudnyi/bb-sync#install"
            target="_blank"
            rel="noreferrer"
          >
            Как установить
          </a>
        </div>
        {copyError && (
          <p role="alert">
            Не удалось скопировать. Инструкция доступна по ссылке «Как
            установить».
          </p>
        )}
      </div>
    </details>
  );
}
function SyncPage() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const [data, setData] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
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
          cause instanceof Error
            ? cause.message
            : "Не удалось получить статус.",
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
  useEffect(() => {
    if (data?.status?.phase !== "syncing") return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [data?.status?.phase, refresh]);
  const planId = data?.status?.planId;
  const choices = selection.planId === planId ? selection.choices : {};
  const setChoices = (next: Choices | ((prev: Choices) => Choices)) =>
    setSelection({
      planId: planId ?? null,
      choices: typeof next === "function" ? next(choices) : next,
    });
  const accept = (next: PublicStatus) => {
    ++requestId.current;
    setData(next);
    setShowSetup(false);
    setRestoreConfirm(false);
  };
  async function perform(task: () => Promise<PublicStatus>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await task();
      if (mounted.current) accept(result);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось выполнить действие.",
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  const status = data?.status;
  const busy = pending || status?.phase === "syncing";
  const failed = status?.phase === "error" || status?.phase === "recovery";
  const needsSetup = data && (!data.configured || showSetup);
  const first =
    data?.configured &&
    (!data.hasBaseline || data.needsReview) &&
    status?.phase !== "recovery";
  const heading =
    status?.phase === "conflict"
      ? "Нужно выбрать настройки"
      : status?.phase === "recovery"
        ? "Применение было прервано"
        : status?.phase === "error"
          ? "Не удалось синхронизировать"
          : busy
            ? "Синхронизация…"
            : data?.enabled
              ? "Настройки синхронизируются"
              : "Синхронизация на паузе";
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-7 px-5 py-6 md:px-8 md:py-9">
        <header className="flex items-center gap-3">
          <svg
            aria-hidden="true"
            width="26"
            height="26"
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="11" width="10" height="8" rx="1.5" />
            <path d="M7 19v2M1 21h12" />
            <rect x="20" y="11" width="10" height="8" rx="1.5" />
            <path d="M25 19v2M19 21h12M9 6h14l-3-3M23 6l-3 3M23 26H9l3-3M9 26l3 3" />
          </svg>
          <h1 className="text-lg font-semibold tracking-tight">Sync</h1>
        </header>
        <Failure
          message={error}
          retry={() => {
            setError(null);
            void refresh();
          }}
        />
        {!data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Загрузка…
          </p>
        ) : needsSetup ? (
          <Setup
            current={data}
            complete={accept}
            cancel={data.configured ? () => setShowSetup(false) : undefined}
          />
        ) : first ? (
          <FirstTransfer complete={accept} onBack={() => setShowSetup(true)} />
        ) : (
          <>
            <section className="space-y-5" aria-live="polite">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-2.5 size-2.5 shrink-0 rounded-full ${failed ? "bg-destructive" : status?.phase === "conflict" ? "bg-foreground" : data.enabled ? "bg-green-600" : "bg-muted-foreground"}`}
                />
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    {heading}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {status?.lastSync
                      ? `Последний успешный перенос — ${new Date(status.lastSync).toLocaleString()}`
                      : "Настройки готовы к переносу между ноутбуками."}
                  </p>
                </div>
              </div>
              {busy && (
                <p role="status" className="text-sm text-muted-foreground">
                  {status?.message}
                </p>
              )}
              {failed && (
                <div className="space-y-2 border-l-2 border-destructive pl-3 text-sm">
                  <p>{status?.message}</p>
                  <Button
                    variant="link"
                    className="h-auto px-0"
                    onClick={() => setShowSetup(true)}
                  >
                    Проверить подключение GitHub
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() => void perform(() => rpc.call("sync"))}
                >
                  {busy ? "Синхронизация…" : "Синхронизировать"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      rpc.call("options", { enabled: !data.enabled }),
                    )
                  }
                >
                  {data.enabled ? "Приостановить" : "Возобновить"}
                </Button>
              </div>
            </section>
            <div className="space-y-3 border-t border-border pt-5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <a
                  href={`https://github.com/${data.repository}`}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all underline-offset-4 hover:underline"
                >
                  {data.repository}
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setShowSetup(true)}
                >
                  Сменить хранилище
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {groups
                  .filter((g) => data.options[g.key])
                  .map((g) => g.title)
                  .join(" · ")}
                {data.enabled
                  ? ` · проверка с интервалом ${data.options.intervalSeconds < 60 ? `${data.options.intervalSeconds} сек.` : `${data.options.intervalSeconds / 60} мин.`}`
                  : " · автоматический перенос выключен"}
              </p>
            </div>
            {status?.conflicts.length ? (
              <section className="space-y-4">
                <h2 className="text-lg font-medium">Выбери значения</h2>
                <p className="text-sm text-muted-foreground">
                  Эти настройки изменились по-разному. Независимые изменения
                  объединим автоматически.
                </p>
                <QuickChoices
                  conflicts={status.conflicts}
                  select={setChoices}
                  disabled={busy}
                />
                {status.conflicts.map((c) => (
                  <ConflictRow
                    key={c.key}
                    conflict={c}
                    selected={choices[c.key]}
                    choose={(side) =>
                      setChoices((prev) => ({ ...prev, [c.key]: side }))
                    }
                    disabled={busy}
                  />
                ))}
                <Button
                  disabled={
                    busy || status.conflicts.some((c) => !choices[c.key])
                  }
                  onClick={() =>
                    void perform(() =>
                      rpc.call("resolve", { planId: planId!, choices }),
                    )
                  }
                >
                  Применить выбор
                </Button>
              </section>
            ) : null}
            <Preferences
              key={JSON.stringify(data.options)}
              current={data}
              busy={busy}
              save={(input) => void perform(() => rpc.call("options", input))}
            />
            <AnotherLaptop repository={data.repository} />
            {status?.backupAt && (
              <details className="space-y-3 border-t border-border pt-5">
                <summary className="cursor-pointer text-sm font-medium">
                  Восстановить предыдущие настройки
                </summary>
                <p className="pt-3 text-sm text-muted-foreground">
                  Снимок от {new Date(status.backupAt).toLocaleString()}.
                  Восстановление изменит только этот ноутбук и приостановит
                  синхронизацию.
                </p>
                {restoreConfirm ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy}
                      variant="destructive"
                      onClick={() => void perform(() => rpc.call("restore"))}
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
              </details>
            )}
            {status?.unsupported.length ? (
              <details className="border-t border-border pt-5 text-sm">
                <summary className="cursor-pointer">
                  Не применяются на этом ноутбуке ({status.unsupported.length})
                </summary>
                <p className="my-3 text-xs text-muted-foreground">
                  Поля выключенных групп и отсутствующих плагинов сохраняются в
                  GitHub.
                </p>
                <ul className="space-y-1">
                  {status.unsupported.map((key) => (
                    <li
                      key={key}
                      className="break-all text-xs text-muted-foreground"
                    >
                      {key}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
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
    title: "Sync",
    icon: "bb-sync/devices",
    component: SyncPage,
  });
  app.slots.settingsSection({
    id: "sync-status",
    title: "Синхронизация",
    component: SyncPage,
  });
});
