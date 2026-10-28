import { ZAICODE_WORKING_CUSTOM_IMAGE_MAX } from "./zaicodeHighlights.js";

export const ZAICODE_WORKING_MEDIA_MAX_DIMENSION = 4096;

export const ZAICODE_WORKING_MEDIA_ACCEPT = [
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/ogg",
].join(",");

const SUPPORTED = new Set(ZAICODE_WORKING_MEDIA_ACCEPT.split(","));

function decodedSize(file: File, url: string): Promise<{ width: number; height: number }> {
  if (file.type.startsWith("video/")) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () =>
        resolve({ width: video.videoWidth, height: video.videoHeight });
      video.onerror = () => reject(new Error("This video codec cannot be decoded by ZAICODE."));
      video.src = url;
    });
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("This image cannot be decoded by ZAICODE."));
    image.src = url;
  });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the media file."));
    reader.onerror = () => reject(new Error("Could not read the media file."));
    reader.readAsDataURL(file);
  });
}

/** Validates the stored working-icon media before replacing the current icon. */
export async function readZaicodeWorkingMedia(file: File): Promise<string> {
  if (!SUPPORTED.has(file.type)) throw new Error("Unsupported picture/video format.");
  if (file.size > ZAICODE_WORKING_CUSTOM_IMAGE_MAX)
    throw new Error("Working-icon media must be 1 MiB or smaller.");
  const url = URL.createObjectURL(file);
  try {
    const { width, height } = await decodedSize(file, url);
    if (width < 1 || height < 1) throw new Error("The media has no readable dimensions.");
    if (
      width > ZAICODE_WORKING_MEDIA_MAX_DIMENSION ||
      height > ZAICODE_WORKING_MEDIA_MAX_DIMENSION
    ) {
      throw new Error(
        `Working-icon media must be at most ${ZAICODE_WORKING_MEDIA_MAX_DIMENSION}×${ZAICODE_WORKING_MEDIA_MAX_DIMENSION}.`,
      );
    }
    return await readDataUrl(file);
  } finally {
    URL.revokeObjectURL(url);
  }
}
