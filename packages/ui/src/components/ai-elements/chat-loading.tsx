"use client";

import type { ComponentPropsWithoutRef } from "react";
import { LoaderIcon } from "lucide-react";
import { isZaicodeProductMode } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ZaicodeWorkingIcon } from "@/zaicode/ZaicodeWorkingIcon.js";

export interface ChatLoadingProps extends ComponentPropsWithoutRef<"div"> {
  loading: boolean;
  size?: "default" | "sm";
  className?: string;
}

export function ChatLoading({ loading, size = "default", className, ...props }: ChatLoadingProps) {
  const { intl } = useZCodeIntl();

  if (!loading) {
    return null;
  }

  const sizeClasses = size === "sm" ? "size-4 text-ui-base" : "size-6";

  return (
    <div
      aria-label={intl.formatMessage({ id: "common.loading" })}
      {...props}
      data-zcode-chat-loading-animate="true"
      role="status"
      className={cn("flex items-center", className)}
    >
      <div className={cn("flex items-center justify-center", size === "sm" ? "size-4" : "size-6")}>
        {isZaicodeProductMode() ? (
          // ZAICODE：转圈 spinner 换成操作员自带的 SAIPEN 头像，并且慢慢转动表示“在干活”（操作员要求转而不是呼吸）。
          <ZaicodeWorkingIcon className={sizeClasses} />
        ) : (
          <LoaderIcon
            aria-hidden="true"
            className={cn("animate-spin text-foreground-subtle", sizeClasses)}
          />
        )}
      </div>
    </div>
  );
}
