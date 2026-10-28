import { useEffect, useRef, useState } from "react";
import { playZaicodeSound } from "@/zaicode/zaicodeSoundBus.js";

const FOCUS_GRACE_MS = 300;

/**
 * ZAICODE 行内重命名（类似资源管理器 F2）：标题原位变成输入框。
 * Enter / 失焦提交，Esc 取消；事件不冒泡到行，避免触发选中、拖拽或右键菜单。
 */
export function TaskInlineRenameInput({
  initialValue,
  ariaLabel,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settledRef = useRef(false);
  const mountedAtRef = useRef(0);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    mountedAtRef.current = performance.now();
    input.focus();
    input.select();
  }, []);

  const settle = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (commit) {
      playZaicodeSound("session.rename");
      onCommit(value);
    }
    else onCancel();
  };

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <input
      ref={inputRef}
      value={value}
      aria-label={ariaLabel}
      spellCheck={false}
      className="h-6 min-w-0 flex-1 border border-[var(--zaicode-highlight,var(--color-input-border-focused))] bg-input px-1 text-ui-base text-foreground outline-none"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        // 从右键菜单进入时，菜单关闭会把焦点还给触发元素；刚挂载时的这次失焦不是用户提交，抢回焦点。
        if (performance.now() - mountedAtRef.current < FOCUS_GRACE_MS) {
          requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          });
          return;
        }
        settle(true);
      }}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onContextMenu={stop}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          settle(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          settle(false);
        }
      }}
    />
  );
}
