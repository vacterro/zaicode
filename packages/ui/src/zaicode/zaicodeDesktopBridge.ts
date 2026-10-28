export interface ZaicodeWindowZone {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  state?: "normal" | "maximized";
}

export interface ZaicodeDesktopWindowBridge {
  moveWindowBy?(delta: { dx: number; dy: number }): Promise<{ success: boolean }>;
  snapWindowZone?(zone: ZaicodeWindowZone): Promise<{ success: boolean }>;
  getWindowZone?(): Promise<Required<ZaicodeWindowZone> | null>;
}

export function getZaicodeDesktopBridge(): ZaicodeDesktopWindowBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { zcode?: ZaicodeDesktopWindowBridge }).zcode;
}
