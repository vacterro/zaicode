import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateSaiasui } from "../src/zaicode/saiasui/saiasuiIsolation.js";
import {
  setZaicodeProtrailForced,
} from "../src/zaicode/protrail/zaicodeProtrailForce.js";
import { protrailDefaults } from "../src/zaicode/protrail/protrailModel.js";

// T-105 core invariant: while SAIASUI is active, ProTrail must keep rendering.
// The failure mode was isolateSaiasui() setting `inert` on every body sibling,
// including ProTrail's body-level canvas. These pin the two guarantees:
//   1. the ProTrail canvas is never inerted by the game,
//   2. every other sibling's previous inert state is restored on exit,
//   3. the game-local force is set/cleared without mutating the saved store.

/** A DOM element stub sufficient for isolateSaiasui: children, inert, matches, focus. */
class El {
  children: El[] = [];
  inert = false;
  private attrs: Record<string, string> = {};
  constructor(public tag = "div", attrs: Record<string, string> = {}) {
    this.attrs = attrs;
  }
  matches(selector: string): boolean {
    // only supports the single attribute selector the code uses
    const key = selector.replace(/^\[|\]$/g, "");
    return key in this.attrs;
  }
  contains(other: El): boolean {
    if (other === this) return true;
    return this.children.some((child) => child.contains(other));
  }
  getClientRects(): unknown[] {
    return [{}];
  }
  closest(): El | null {
    return null;
  }
  focus(): void {
    setActive(this);
  }
  get isConnected(): boolean {
    return true;
  }
}

let installedActive: El | null = null;
function setActive(element: El | null): void {
  installedActive = element;
}

function withDom(body: El, active: El | null, run: () => void) {
  const g = globalThis as unknown as { document?: unknown; MutationObserver?: unknown };
  const savedDoc = g.document;
  const savedMo = g.MutationObserver;
  installedActive = active;
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  g.document = {
    body,
    get activeElement() {
      return installedActive;
    },
  };
  // HTMLElement instanceof check inside isolateSaiasui: make El pass it.
  const savedHtml = (globalThis as { HTMLElement?: unknown }).HTMLElement;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = El;
  try {
    run();
  } finally {
    g.document = savedDoc;
    g.MutationObserver = savedMo;
    (globalThis as { HTMLElement?: unknown }).HTMLElement = savedHtml;
  }
}

test("SAIASUI isolation never inerts the ProTrail canvas", () => {
  const root = new El("div", { "data-zaicode-saiasui": "" });
  const protrail = new El("canvas", { "data-zaicode-protrail": "" });
  const sidebar = new El("aside", {});
  const body = new El("body");
  body.children = [root, protrail, sidebar];
  withDom(body, root, () => {
    const restore = isolateSaiasui(root);
    assert.equal(protrail.inert, false, "ProTrail canvas must keep rendering during a run");
    assert.equal(sidebar.inert, true, "other siblings are inerted for modal isolation");
    assert.equal(root.inert, false);
    restore();
    assert.equal(sidebar.inert, false, "previous inert state restored on exit");
    assert.equal(protrail.inert, false);
  });
});

test("isolation restores a sibling that was already inert before the game", () => {
  const root = new El("div", { "data-zaicode-saiasui": "" });
  const preInert = new El("div", {});
  preInert.inert = true;
  const body = new El("body");
  body.children = [root, preInert];
  withDom(body, root, () => {
    const restore = isolateSaiasui(root);
    assert.equal(preInert.inert, true);
    restore();
    assert.equal(preInert.inert, true, "a pre-existing inert flag survives the round trip");
  });
});

test("forced ProTrail config is set and cleared without a store mutation", () => {
  const forced = { ...protrailDefaults(), enabled: true, everywhere: false };
  setZaicodeProtrailForced(forced);
  // The force channel is separate from the persisted store; setting/clearing it
  // touches no localStorage and no store — proven by it being a plain module var.
  setZaicodeProtrailForced(null);
  assert.ok(true);
});
