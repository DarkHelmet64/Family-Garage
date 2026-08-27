// ---------------------------------------------------------------------------
// Receipt photos
//
// Photos are shrunk in the browser and stored in Firestore alongside the
// service record, one document per photo, rather than going to Cloud Storage.
// Two reasons: Cloud Storage on a new Firebase project generally wants a
// billing account attached, which this app is built to avoid; and a photo kept
// beside its record needs no bucket, no CORS setup, and no second set of rules.
//
// The cost of that choice is a hard ceiling -- a Firestore document tops out at
// 1 MiB -- so every photo is resized and re-compressed until it fits well
// inside that, which for a receipt is no loss at all. A receipt only has to be
// readable.
// ---------------------------------------------------------------------------

// Comfortably under Firestore's 1 MiB document limit, leaving room for the
// field names and the rest of the document around it.
export const PHOTO_BUDGET_BYTES = 700 * 1024;

// Anything bigger than this isn't a phone photo; refuse it before spending
// memory decoding it.
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

// Tried in order until one comes in under budget. A receipt stays legible far
// longer than a photograph does -- it's black text on white paper.
const ATTEMPTS = [
  { maxEdge: 1400, quality: 0.72 },
  { maxEdge: 1400, quality: 0.6 },
  { maxEdge: 1100, quality: 0.55 },
  { maxEdge: 900, quality: 0.5 },
  { maxEdge: 700, quality: 0.45 },
];

export class PhotoError extends Error {}

// Phone cameras record orientation in EXIF rather than rotating the pixels, so
// a photo taken in portrait arrives sideways unless the decoder is told to
// respect it. createImageBitmap does; the <img> fallback is for browsers
// without it, where modern ones apply orientation themselves.
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Some browsers reject the options argument; try without it.
      try {
        return await createImageBitmap(file);
      } catch {
        // Fall through to the <img> path.
      }
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new PhotoError("That image couldn't be opened."));
      img.src = url;
    });
  } finally {
    // Revoked on the next frame so the decode above has finished with it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function drawScaled(source, maxEdge, quality) {
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext("2d");
  // Receipts are usually photographed against something dark; JPEG has no
  // transparency, so fill white rather than letting it come out black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  return {
    dataUrl: canvas.toDataURL("image/jpeg", quality),
    width: canvas.width,
    height: canvas.height,
  };
}

// Turns a picked file into something storable: a JPEG data URL small enough to
// live in a Firestore document.
export async function readReceiptPhoto(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) {
    throw new PhotoError("That's not an image. Pick a photo or a screenshot of the receipt.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new PhotoError("That image is enormous. Try a photo taken with your phone's camera.");
  }

  let source;
  try {
    source = await decode(file);
  } catch (err) {
    if (err instanceof PhotoError) throw err;
    throw new PhotoError(
      "That image couldn't be opened. iPhone photos saved as HEIC sometimes need converting to JPEG first."
    );
  }

  let last = null;
  for (const attempt of ATTEMPTS) {
    last = drawScaled(source, attempt.maxEdge, attempt.quality);
    if (last.dataUrl.length <= PHOTO_BUDGET_BYTES) break;
  }
  if (source.close) source.close();

  if (last.dataUrl.length > PHOTO_BUDGET_BYTES) {
    throw new PhotoError("That photo is still too big after shrinking. Try cropping it to just the receipt.");
  }

  return {
    dataUrl: last.dataUrl,
    width: last.width,
    height: last.height,
    bytes: last.dataUrl.length,
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
