import { useCallback, useEffect, useRef, useState } from "react";
import type { ZaicodeRouterHistory } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import {
  useZaicodeRouter,
  zaicodeRouterCall,
  zaicodeRouterChange,
} from "@/zaicode/zaicodeRouter.js";

/** Private historical lists are recovery choices; current pools remain router-owned. */
export function ZaicodeRouterRecovery() {
  const combos = useZaicodeRouter((state) => state.combos);
  const busy = useZaicodeRouter((state) => state.busy);
  const [history, setHistory] = useState<ZaicodeRouterHistory>({ snapshots: [], unreadable: 0 });
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState("");
  const [confirm, setConfirm] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await zaicodeRouterCall<ZaicodeRouterHistory>({
        method: "GET",
        path: "/zaicode/recovery",
      });
      if (request !== generation.current) return;
      if (result.ok && result.data) {
        setHistory(result.data);
        setError("");
      } else setError(result.message);
    } catch (cause) {
      if (request === generation.current) setError(String(cause));
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [combos, load]);
  const snapshot = selected
    ? history.snapshots.find((item) => item.id === selected)
    : history.snapshots[0];
  const save = async () => {
    const result = await zaicodeRouterChange("Saving preset", {
      method: "POST",
      path: "/zaicode/recovery/snapshot",
      body: { label: label.trim() },
    });
    toast(result.message);
    if (result.ok) setLabel("");
    await load();
  };
  const restore = async () => {
    if (!snapshot) return;
    setConfirm(false);
    const result = await zaicodeRouterChange("Restoring model lists", {
      method: "POST",
      path: "/zaicode/recovery/restore",
      body: { id: snapshot.id },
    });
    toast(result.message);
    await load();
  };
  return (
    <section
      className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-base"
      data-zaicode-router-recovery
    >
      <h2 className="text-ui-lg text-foreground">Backups &amp; presets</h2>
      <p className="text-foreground-subtle">
        Model lists are backed up before edits. Restore a list after accidental removal, or save a
        named preset.
      </p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {history.unreadable ? (
        <p role="alert" className="text-destructive">
          {history.unreadable} damaged backup(s) cannot be used. Choose another backup.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <label htmlFor="zaicode-router-preset-name">Preset name</label>
        <input
          id="zaicode-router-preset-name"
          className="min-w-0 flex-1 border border-border bg-background px-1 text-foreground"
          value={label}
          maxLength={100}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!!busy || !label.trim() || !combos.length}
          onClick={() => void save()}
        >
          Save preset
        </Button>
      </div>
      <label htmlFor="zaicode-router-backup">Saved model lists</label>
      <select
        id="zaicode-router-backup"
        className="min-w-0 max-w-full border border-border bg-background text-foreground"
        value={snapshot?.id ?? ""}
        disabled={!!busy || !history.snapshots.length}
        onChange={(event) => {
          setSelected(event.target.value);
          setConfirm(false);
        }}
      >
        {!history.snapshots.length ? <option value="">No saved lists yet</option> : null}
        {history.snapshots.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label} · {new Date(item.createdAt).toLocaleString()} · {item.pools} pools,{" "}
            {item.models} models
          </option>
        ))}
      </select>
      {confirm && snapshot ? (
        <div className="flex flex-col gap-1 border border-border p-2">
          <p>
            Restore “{snapshot.label}”? Matching pools&apos; model lists will be replaced and
            missing pools recreated. Other pools, connections and settings are kept. Current lists
            are backed up first.
          </p>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void restore()}>
              Restore model lists
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={!!busy || !snapshot}
          onClick={() => {
            setSelected(snapshot?.id ?? "");
            setConfirm(true);
          }}
        >
          Restore selected list…
        </Button>
      )}
    </section>
  );
}
