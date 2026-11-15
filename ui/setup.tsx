import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useState } from "react";
import { Button } from "../components/ui/button";
import type { PublicStatus, rpcContract, SetupState } from "../server";
import type { Preview } from "../src/engine";
import { displayValue, settingLabel } from "../src/labels";
import type { Choices } from "../src/model";
import type { AuthState, Repository } from "../src/onboarding";
import {
  ConflictRow,
  copyText,
  Failure,
  inputClass,
  QuickChoices,
  ScopePicker,
} from "./shared";

export function FirstTransfer({
  complete,
  onBack,
}: {
  complete: (result: PublicStatus) => void;
  onBack?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(false);
  const [choices, setChoices] = useState<Choices>({});
  async function load() {
    setPreview(null);
    setError(null);
    setChoices({});
    try {
      setPreview(await rpc.call("preview"));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось сравнить настройки.",
      );
    }
  }
  useEffect(() => {
    let active = true;
    rpc.call("preview").then(
      (v) => {
        if (active) setPreview(v);
      },
      (e: unknown) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "Не удалось сравнить настройки.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  const conflicts = preview?.changes.filter((c) => c.conflicting) ?? [];
  async function finish(side?: "local" | "remote") {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const selected = side
        ? Object.fromEntries(conflicts.map((c) => [c.key, side]))
        : choices;
      const result = await rpc.call("setup_finish", {
        planId: preview.planId,
        choices: selected,
      });
      if (result.status?.phase === "synced") complete(result);
      else {
        setError(result.status?.message ?? "Не удалось применить настройки.");
        setPreview(null);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось завершить подключение.",
      );
    } finally {
      setBusy(false);
    }
  }
  const identical = preview?.remoteExists && preview.changes.length === 0;
  const comparing =
    compare || (!!preview && !preview.firstConnection && conflicts.length > 0);
  return (
    <section className="space-y-5">
      <div>
        <p className="mb-2 text-xs text-muted-foreground">Последний шаг</p>
        <h2 className="text-2xl font-semibold tracking-tight">
          {identical
            ? "Настройки уже совпадают"
            : preview?.remoteExists
              ? preview.firstConnection
                ? "Какие настройки использовать?"
                : "Проверим изменения"
              : "Всё готово к первому запуску"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {identical
            ? "Осталось включить автоматический перенос изменений между ноутбуками."
            : preview?.remoteExists
              ? preview.firstConnection
                ? "В хранилище уже есть настройки. Выбери их для этого ноутбука или сравни различия."
                : "Независимые изменения объединим автоматически. Если одна настройка изменилась по-разному, выбери нужное значение."
              : "Сохраним выбранные настройки этого ноутбука. Дальше изменения будут переноситься автоматически."}
        </p>
      </div>
      <Failure message={error} retry={load} />
      {!preview && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Сравниваем настройки…
        </p>
      )}
      {preview && (
        <>
          <p className="text-sm">
            {identical
              ? "Все выбранные настройки совпадают"
              : preview.remoteExists
                ? `${preview.changes.length} различий · ${conflicts.length} требуют выбора`
                : `${preview.localCount} настроек готовы к сохранению`}
          </p>
          {!comparing ? (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void finish(preview.remoteExists ? "remote" : "local")
                }
              >
                {busy
                  ? "Подключаем…"
                  : identical
                    ? "Включить синхронизацию"
                    : !preview.firstConnection
                      ? "Объединить и включить"
                      : preview.remoteExists
                        ? "Использовать настройки из GitHub"
                        : "Начать синхронизацию"}
              </Button>
              {preview.remoteExists && preview.changes.length > 0 && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setCompare(true)}
                >
                  Сравнить и выбрать
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {conflicts.length > 0 && (
                <QuickChoices
                  conflicts={conflicts}
                  select={setChoices}
                  disabled={busy}
                />
              )}
              {preview.changes.map((c) =>
                c.conflicting ? (
                  <ConflictRow
                    key={c.key}
                    conflict={c}
                    selected={choices[c.key]}
                    disabled={busy}
                    choose={(side) =>
                      setChoices((prev) => ({ ...prev, [c.key]: side }))
                    }
                  />
                ) : (
                  <div
                    key={c.key}
                    className="border-t border-border py-3 text-sm"
                  >
                    <p>{settingLabel(c.key)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Этот ноутбук: {displayValue(c.local, c.localPresent)}
                      <br />
                      GitHub: {displayValue(c.remote, c.remotePresent)}
                      <br />
                      Объединим автоматически
                    </p>
                  </div>
                ),
              )}
              <Button
                disabled={busy || conflicts.some((c) => !choices[c.key])}
                onClick={() => void finish()}
              >
                {busy ? "Применяем…" : "Применить и включить синхронизацию"}
              </Button>
            </div>
          )}
          {preview.firstConnection &&
            preview.remoteExists &&
            !identical &&
            !comparing && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Сохранить настройки этого ноутбука вместо GitHub
                </summary>
                <p className="my-3 text-xs text-muted-foreground">
                  Различающиеся настройки в хранилище будут заменены значениями
                  этого ноутбука. Другие ноутбуки получат эти изменения.
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void finish("local")}
                >
                  Использовать настройки этого ноутбука
                </Button>
              </details>
            )}
          <p className="text-xs text-muted-foreground">
            Автосинхронизация включится после успешного переноса. Перед
            изменением локальных настроек сохраним снимок.
          </p>
        </>
      )}
      {onBack && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onBack}>
          Выбрать другое хранилище
        </Button>
      )}
    </section>
  );
}

export function Setup({
  current,
  complete,
  cancel,
}: {
  current: PublicStatus;
  complete: (status: PublicStatus) => void;
  cancel?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<SetupState | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState(
    current.repository ? "existing" : "recommended",
  );
  const [repository, setRepository] = useState(current.repository);
  const [scope, setScope] = useState({
    appearance: current.options.appearance,
    keyboard: current.options.keyboard,
    interface: current.options.interface,
  });
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function load() {
    setError(null);
    const result = await rpc.call("setup_load");
    setState(result);
    setAuth(result.auth);
    if (result.account) {
      const list = await rpc.call("repositories", { page: 1 });
      setRepos(list.repositories);
      setMore(list.more);
      setPage(1);
    }
  }
  useEffect(() => {
    let active = true;
    rpc.call("setup_load").then(
      (result) => {
        if (active) {
          setState(result);
          setAuth(result.auth);
        }
      },
      (e: unknown) => {
        if (active)
          setError(
            e instanceof Error
              ? e.message
              : "Не удалось загрузить подключение.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  useEffect(() => {
    if (!state?.account?.login) return;
    let active = true;
    rpc.call("repositories", { page: 1 }).then(
      (list) => {
        if (active) {
          setRepos(list.repositories);
          setMore(list.more);
        }
      },
      (e: unknown) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить хранилища.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, state?.account?.login]);
  const waiting = auth?.phase === "starting" || auth?.phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    let active = true;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      rpc
        .call("auth_status")
        .then(async (next) => {
          if (!active) return;
          if (next.phase === "connected") {
            const result = await rpc.call("setup_load");
            if (active) {
              setState(result);
              setAuth(result.auth);
            }
          } else setAuth(next);
        })
        .catch(() => {
          if (active) setError("Соединение прервано. Повтори подключение.");
        })
        .finally(() => {
          running = false;
        });
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc, waiting]);
  async function action(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось выполнить действие.",
      );
    } finally {
      setBusy(false);
    }
  }
  const account = state?.account;
  const step = prepared ? 3 : account ? 2 : 1;
  const repositoryId = useId();
  const suggestionsId = useId();
  return (
    <div className="space-y-7">
      <ol
        aria-label="Этапы подключения"
        className="flex gap-5 text-xs text-muted-foreground"
      >
        {["GitHub", "Хранилище", "Первый перенос"].map((label, index) => (
          <li
            key={label}
            aria-current={step === index + 1 ? "step" : undefined}
            className={step === index + 1 ? "font-medium text-foreground" : ""}
          >
            {index + 1 < step ? "✓" : index + 1} · {label}
          </li>
        ))}
      </ol>
      <Failure message={error} retry={() => void action(load)} />
      {prepared ? (
        <FirstTransfer complete={complete} onBack={() => setPrepared(false)} />
      ) : !state && !error ? (
        <p role="status" className="text-sm text-muted-foreground">
          Проверяем подключение…
        </p>
      ) : !account ? (
        <section className="space-y-5">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Подключи GitHub
            </h2>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              Настройки будут храниться в твоём приватном репозитории. Если на
              этом компьютере уже выполнен вход в GitHub, используем его.
            </p>
          </div>
          {state?.error && <Failure message={state.error} />}
          {auth?.message && <Failure message={auth.message} />}
          {auth?.code ? (
            <div className="space-y-3">
              <p className="text-sm">Открой GitHub и введи одноразовый код:</p>
              <div className="flex items-center gap-3">
                <output className="font-mono text-3xl tracking-widest">
                  {auth.code}
                </output>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    copyText(auth.code!).then(
                      () => setCopied(true),
                      () =>
                        setError(
                          "Не удалось скопировать код. Введи его вручную.",
                        ),
                    );
                  }}
                >
                  {copied ? "Скопировано" : "Скопировать"}
                </Button>
              </div>
              <Button
                onClick={() =>
                  navigate.openUrl("https://github.com/login/device")
                }
              >
                Открыть GitHub
              </Button>
              <p className="text-xs text-muted-foreground">
                После подтверждения продолжим автоматически.
              </p>
            </div>
          ) : (
            <Button
              disabled={busy || waiting}
              onClick={() =>
                void action(async () => {
                  setCopied(false);
                  setAuth(await rpc.call("auth_start"));
                })
              }
            >
              {waiting
                ? "Подключаем GitHub…"
                : auth?.phase === "error" || auth?.phase === "missing"
                  ? "Повторить подключение"
                  : "Подключить GitHub"}
            </Button>
          )}
          {auth?.phase === "missing" && (
            <a
              href="https://cli.github.com/"
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm underline underline-offset-4"
            >
              Установить GitHub CLI
            </a>
          )}
          {waiting && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void action(async () => {
                  setAuth(await rpc.call("auth_cancel"));
                })
              }
            >
              Отменить вход
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Токен не нужно копировать или вставлять. Доступ сохранится только на
            сервере bb.
          </p>
        </section>
      ) : (
        <section className="space-y-6">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              GitHub · {account.login}
            </p>
            <Button
              variant="link"
              size="sm"
              className="mb-3 h-auto px-0 text-xs"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const next = await rpc.call("auth_restart");
                  setState((previous) =>
                    previous
                      ? { ...previous, account: null, error: null }
                      : previous,
                  );
                  setAuth(next);
                })
              }
            >
              Подключить GitHub заново
            </Button>
            <h2 className="text-2xl font-semibold tracking-tight">
              Где хранить настройки?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              На всех ноутбуках выбери одно и то же хранилище.
            </p>
          </div>
          <fieldset disabled={busy} className="space-y-4">
            <legend className="sr-only">Хранилище</legend>
            <label className="flex cursor-pointer gap-3 text-sm">
              <input
                type="radio"
                name="storage"
                checked={mode === "recommended"}
                onChange={() => setMode("recommended")}
                className="mt-1 accent-current"
              />
              <span>
                <span className="block break-all font-medium">
                  {account.login}/bb-sync-settings
                </span>
                <span className="text-xs text-muted-foreground">
                  Рекомендуемое · создадим приватный репозиторий, если его ещё
                  нет
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-3 text-sm">
              <input
                type="radio"
                name="storage"
                checked={mode === "existing"}
                onChange={() => setMode("existing")}
                className="mt-1 accent-current"
              />
              <span>Другое приватное хранилище</span>
            </label>
            {mode === "existing" && (
              <div className="space-y-3 pl-6">
                <label
                  htmlFor={repositoryId}
                  className="block text-xs text-muted-foreground"
                >
                  Приватное хранилище
                </label>
                <input
                  id={repositoryId}
                  list={suggestionsId}
                  autoComplete="off"
                  className={inputClass}
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder="username/bb-sync-settings"
                />
                <datalist id={suggestionsId}>
                  {repos.map((repo) => (
                    <option key={repo.fullName} value={repo.fullName} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">
                  Выбери подсказку или введи owner/repository.
                </p>
                {more && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() =>
                      void action(async () => {
                        const list = await rpc.call("repositories", {
                          page: page + 1,
                        });
                        setRepos((prev) => [
                          ...new Map(
                            [...prev, ...list.repositories].map((r) => [
                              r.fullName,
                              r,
                            ]),
                          ).values(),
                        ]);
                        setPage(page + 1);
                        setMore(list.more);
                      })
                    }
                  >
                    Загрузить ещё
                  </Button>
                )}
              </div>
            )}
          </fieldset>
          <div className="border-t border-border pt-5">
            <ScopePicker scope={scope} onChange={setScope} disabled={busy} />
          </div>
          <Button
            disabled={
              busy ||
              !Object.values(scope).some(Boolean) ||
              (mode === "existing" && !repository.trim())
            }
            onClick={() =>
              void action(async () => {
                await rpc.call("setup_prepare", {
                  create: mode === "recommended",
                  repository:
                    mode === "recommended"
                      ? "bb-sync-settings"
                      : repository.trim(),
                  scope,
                });
                setPrepared(true);
              })
            }
          >
            {busy ? "Готовим хранилище…" : "Продолжить"}
          </Button>
        </section>
      )}
      {cancel && !waiting && !prepared && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
          Вернуться к синхронизации
        </Button>
      )}
    </div>
  );
}
