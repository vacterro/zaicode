import { toArrayBuffer, type PresetBlobStore } from "./zaicodePresetAssets.js";

/**
 * The bytes of every own sound a saved preset (or an Undo record) carries, kept by sha256 in the window's
 * IndexedDB (T-125). A sound is here once whatever number of presets names it. The preset list itself, which
 * only holds digests, stays in localStorage.
 */

const DB_NAME = "zaicode-preset-blobs";
const STORE = "blobs";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const zaicodePresetBlobStore: PresetBlobStore = {
  get: async (sha256) => {
    const value = await run("readonly", (store) => store.get(sha256));
    return value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  },
  put: async (sha256, bytes) => {
    await run("readwrite", (store) => store.put(toArrayBuffer(bytes), sha256));
  },
  keys: async () => (await run("readonly", (store) => store.getAllKeys())).map(String),
  remove: async (sha256) => {
    await run("readwrite", (store) => store.delete(sha256));
  },
};
