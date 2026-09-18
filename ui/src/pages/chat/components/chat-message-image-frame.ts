import type { ImageBlock } from "./chat-message-media.ts";

const MIN_CHAT_IMAGE_PREVIEW_WIDTH = 160;

export function chatImageFrameStyle(image: ImageBlock): string {
  const sized =
    Number.isFinite(image.width) &&
    image.width! > 0 &&
    Number.isFinite(image.height) &&
    image.height! > 0;
  const ratio = sized ? image.width! / image.height! : 3 / 2;
  const width = sized
    ? image.width! < MIN_CHAT_IMAGE_PREVIEW_WIDTH
      ? MIN_CHAT_IMAGE_PREVIEW_WIDTH
      : Math.min(image.width!, 400, 360 * ratio)
    : 400;
  const height = Math.min(360, width / ratio);
  return `--chat-image-width: ${width}px; --chat-image-ratio: ${width} / ${height}`;
}
