import {
  cloneElement,
  isValidElement,
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";

interface ControlHintTooltipProps {
  children: ReactNode;
  title: ReactNode;
  description?: string;
  shortcut?: string;
  standalone?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"];
  className?: string;
  triggerClassName?: string;
  triggerRef?: Ref<HTMLElement>;
}

type TriggerChildProps = {
  className?: string;
  ref?: Ref<HTMLElement>;
};

const shortcutKbdBaseClassName =
  "rounded-md h-4 inline-flex items-center bg-tooltip-tag px-1.5 text-ui-xs font-medium text-tooltip-tag-foreground";

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

/**
 * Classes for a hint's content card.
 *
 * SRC-058 (the tooltip that blinks on hover): hints open instantly and slide in
 * toward their trigger, 2 px away. With the pointer near the trigger's edge the
 * card lands under the pointer, the trigger gets pointerleave, the hint closes,
 * the pointer is over the trigger again and the hint reopens -- a blink loop.
 * A hint is text, never a hover target, so its card takes no pointer events and
 * cannot steal the hover from the control it describes. Kept last so a caller's
 * className cannot turn it back on.
 */
export function controlHintContentClassName(hasDescription: boolean, className?: string): string {
  return cn(
    hasDescription
      ? "max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
      : "max-w-[min(28rem,calc(100vw-1rem))] items-center gap-2 px-2.5 py-1 text-left has-data-[slot=kbd]:pr-1",
    className,
    "pointer-events-none select-none",
  );
}

/** True only when the complete title is already readable on the actual control. */
export function controlHintRepeatsVisibleLabel(trigger: HTMLElement, title: string): boolean {
  const document = trigger.ownerDocument;
  const walker = document.createTreeWalker(trigger, NodeFilter.SHOW_TEXT);
  const labels: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    let visible = true;
    for (
      let element = node.parentElement;
      element && trigger.contains(element);
      element = element.parentElement
    ) {
      const style = document.defaultView?.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (
        element.hidden ||
        element.getAttribute("aria-hidden") === "true" ||
        style?.display === "none" ||
        style?.visibility === "hidden" ||
        bounds.width <= 1 ||
        bounds.height <= 1
      ) {
        visible = false;
        break;
      }
      // 截断标题仍有信息价值；不能因为 textContent 包含全文就删除提示。
      if (
        (style?.overflowX !== "visible" && element.scrollWidth > element.clientWidth + 1) ||
        (style?.overflowY !== "visible" && element.scrollHeight > element.clientHeight + 1)
      )
        return false;
    }
    if (visible) labels.push(node.textContent);
  }
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(labels.join(" ")) === normalize(title);
}

export function ControlHintTooltip({
  children,
  title,
  description,
  shortcut,
  standalone = false,
  open,
  onOpenChange,
  side = "top",
  align = "center",
  sideOffset = 2,
  className,
  triggerClassName,
  triggerRef,
}: ControlHintTooltipProps) {
  const [hintOpen, setHintOpen] = useState(false);
  const triggerElement = useRef<HTMLElement | null>(null);
  const useAppleShortcutFont = isAppleKeyboardPlatform();
  const shortcutFontClassName = useAppleShortcutFont ? "tracking-normal" : "font-mono";
  const shortcutFontStyle = useAppleShortcutFont
    ? {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif',
      }
    : undefined;
  const isTriggerElement = isValidElement<TriggerChildProps>(children);
  const childRef = isTriggerElement ? children.props.ref : undefined;
  // Radix Tooltip/Dropdown/Popper 的 asChild trigger 会在 ref 变化时同步 setState。
  // 这里必须稳定 callback ref 身份，否则每次 render 都会触发 ref detach/attach 并形成更新循环。
  const composedTriggerRef = useCallback(
    (value: HTMLElement | null) => {
      triggerElement.current = value;
      setRef(childRef, value);
      setRef(triggerRef, value);
    },
    [childRef, triggerRef],
  );
  const handleOpenChange = useCallback(
    (next: boolean) => {
      // 可见完整标签的原样复读不解释任何事；图标、快捷键和说明仍保留提示。
      const repeated =
        next &&
        open === undefined &&
        !description &&
        !shortcut &&
        typeof title === "string" &&
        triggerElement.current &&
        controlHintRepeatsVisibleLabel(triggerElement.current, title);
      const allowed = next && !repeated;
      setHintOpen(allowed);
      onOpenChange?.(allowed);
    },
    [description, shortcut, title, open, onOpenChange],
  );
  const trigger = isTriggerElement ? (
    cloneElement(children, {
      // 以前额外包一层 span，Radix Tooltip/Select/Popover 多层 asChild 组合时，
      // 事件和 ref 会落到不同 DOM 上，触发 SlotClone 渲染栈错误。这里直接合到真实触发器。
      className: cn("shrink-0", children.props.className, triggerClassName),
      ref: composedTriggerRef,
    })
  ) : (
    <span ref={composedTriggerRef} className={cn("inline-flex shrink-0", triggerClassName)}>
      {children}
    </span>
  );

  // 大会话会为每条消息动作渲染大量 ControlHintTooltip，逐个创建 Provider
  // 会把 Radix 上下文树放大到消息数量级；共享 Provider 统一放在 Root。
  const tooltip = (
    <Tooltip
      open={open ?? hintOpen}
      onOpenChange={handleOpenChange}
      // SRC-051: with instant-open tooltips, hoverable content let pointer jitter
      // between the trigger and the popped card close/reopen it in a loop (the
      // flicker); a hint is read where it appears, not hovered onto.
      disableHoverableContent
    >
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={controlHintContentClassName(Boolean(description), className)}
      >
        {description ? (
          <div className="flex w-full items-start justify-between gap-3">
            <span className="text-ui-sm font-medium leading-4 text-tooltip-foreground">
              {title}
            </span>
            {shortcut ? (
              <kbd
                data-slot="kbd"
                className={cn(shortcutKbdBaseClassName, shortcutFontClassName, "shrink-0")}
                style={shortcutFontStyle}
              >
                {shortcut}
              </kbd>
            ) : null}
          </div>
        ) : (
          // 无描述的提示过去同时受 max-w-xs 和 nowrap 约束，长中英文文案会越界裁剪。
          // 短提示继续按内容宽度展示，超过视口安全宽度时允许自然换行；显式换行用于结构化提示。
          <span className="text-ui-sm font-medium whitespace-pre-line break-words text-tooltip-foreground">
            {title}
          </span>
        )}
        {description ? (
          <span className="max-w-64 text-ui-sm/relaxed text-tooltip-foreground/80">
            {description}
          </span>
        ) : null}
        {!description && shortcut ? (
          <kbd
            data-slot="kbd"
            className={cn(shortcutKbdBaseClassName, shortcutFontClassName, "shrink-0")}
            style={shortcutFontStyle}
          >
            {shortcut}
          </kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );

  // 少数组件需要支持脱离 Root 的 SSR/单测渲染；由封装按需补 Provider，
  // 避免业务层重新组合 Tooltip primitives，同时不让列表中的常规提示重复创建上下文。
  return standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip;
}
