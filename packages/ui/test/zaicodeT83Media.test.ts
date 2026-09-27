import assert from "node:assert/strict";
import test from "node:test";
import { readZaicodeWorkingMedia } from "../src/zaicode/zaicodeWorkingMedia.js";

test("working media keeps 1 MiB and 4096px boundaries and revokes preview URLs", async () => {
  const originalImage = globalThis.Image;
  const originalReader = globalThis.FileReader;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let dimension = 4096;
  let corrupt = false;
  let created = 0;
  let revoked = 0;

  class ImageDecoder {
    naturalWidth = dimension;
    naturalHeight = dimension;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_url: string) {
      queueMicrotask(() => (corrupt ? this.onerror?.() : this.onload?.()));
    }
  }
  class DataReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      this.result = "data:image/png;base64,AA==";
      queueMicrotask(() => this.onload?.());
    }
  }

  try {
    globalThis.Image = ImageDecoder as unknown as typeof Image;
    globalThis.FileReader = DataReader as unknown as typeof FileReader;
    URL.createObjectURL = () => {
      created++;
      return "blob:working-icon";
    };
    URL.revokeObjectURL = () => {
      revoked++;
    };
    const valid = new File([new Uint8Array(1024 * 1024)], "icon.png", { type: "image/png" });
    assert.equal(await readZaicodeWorkingMedia(valid), "data:image/png;base64,AA==");
    assert.equal(created, 1);
    assert.equal(revoked, 1);

    dimension = 4097;
    await assert.rejects(readZaicodeWorkingMedia(valid), /4096×4096/);
    assert.equal(revoked, 2, "rejected dimensions release the temporary URL");

    corrupt = true;
    dimension = 4096;
    await assert.rejects(readZaicodeWorkingMedia(valid), /cannot be decoded/);
    assert.equal(revoked, 3, "corrupt media releases the temporary URL");

    await assert.rejects(
      readZaicodeWorkingMedia(
        new File([new Uint8Array(1024 * 1024 + 1)], "big.png", { type: "image/png" }),
      ),
      /1 MiB/,
    );
    await assert.rejects(
      readZaicodeWorkingMedia(new File(["bad"], "bad.txt", { type: "text/plain" })),
      /Unsupported/,
    );
    assert.equal(created, 3, "oversize and unsupported files never get a preview URL");
  } finally {
    globalThis.Image = originalImage;
    globalThis.FileReader = originalReader;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
