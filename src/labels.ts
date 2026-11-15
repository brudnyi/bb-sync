const labels: Record<string, string> = {
  "appearance/themeId": "Тема",
  "appearance/faviconColor": "Цвет значка",
  "general/showKeyboardHints": "Подсказки горячих клавиш",
  "general/confirmThreadArchive": "Подтверждение архивации",
  "general/steerActiveThreadOnEnter": "Отправка в работающий чат по Enter",
  "general/summarizeShellCommands": "Краткие описания команд",
  "general/terminalCopyOnSelect": "Копирование выделения в терминале",
  "general/streamerMode": "Режим стримера",
  "ui/sidebar.footerOrder": "Порядок кнопок внизу меню",
  "ui/sidebar.hiddenFooterItems": "Скрытые кнопки меню",
  "ui/sidebar.pluginPanelOrder": "Порядок разделов",
  "ui/sidebar.visiblePluginPanels": "Видимые разделы",
  "ui/sidebar.navigationProvider": "Вид навигации",
  "ui/sidebar.threadListProvider": "Вид списка чатов",
  "ui/composer.provider": "Поле ввода сообщения",
  "ui/infoPanel.collapsedSections": "Свёрнутые разделы информации",
  "ui/threadContextCard.pinned": "Закреплённая карточка контекста",
};
const commands: Record<string, string> = {
  "panel.close": "Закрыть панель",
  "panel.toggle": "Показать панель",
  "palette.open": "Палитра команд",
  "thread.new": "Новый чат",
  "sidebar.toggle": "Боковое меню",
  "composer.focus": "Перейти к сообщению",
  "terminal.open": "Открыть терминал",
  "history.back": "Назад",
  "history.forward": "Вперёд",
};
export function settingLabel(key: string): string {
  if (labels[key]) return labels[key];
  if (key.startsWith("keyboard/")) {
    const [, raw, platform] = key.split("/");
    let command = raw ?? "";
    try {
      command = decodeURIComponent(command);
    } catch {
      /* Show the original field name. */
    }
    return `${commands[command] ?? command} · ${platform === "all" ? "все платформы" : platform === "mac" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}`;
  }
  return key;
}
export function displayValue(value: unknown, present: boolean): string {
  if (!present) return "По умолчанию";
  if (value === null) return "Отключено";
  if (typeof value === "boolean") return value ? "Включено" : "Выключено";
  if (typeof value === "string")
    return value === "__automatic__" ? "Автоматически" : value;
  if (value && typeof value === "object" && "key" in value) {
    const v = value as Record<string, unknown>;
    return [
      v.mod && "⌘ / Ctrl",
      v.meta && "⌘",
      v.control && "Ctrl",
      v.alt && "Alt",
      v.shift && "Shift",
      v.key,
    ]
      .filter(Boolean)
      .join(" + ");
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Нет";
  return JSON.stringify(value);
}
