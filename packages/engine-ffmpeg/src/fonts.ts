import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TextStyle } from "@video-editor/core";

/** Best-effort resolution of a TTF for drawtext, per platform. */
export function defaultFontsDir(): string {
  if (process.platform === "win32") return "C:/Windows/Fonts";
  if (process.platform === "darwin") return "/System/Library/Fonts/Supplemental";
  return "/usr/share/fonts";
}

export function chooseFontFile(style: TextStyle, fontsDir = defaultFontsDir()): string {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    if (style.bold && style.italic) candidates.push("arialbi.ttf");
    else if (style.bold) candidates.push("arialbd.ttf");
    else if (style.italic) candidates.push("ariali.ttf");
    candidates.push("arial.ttf", "segoeui.ttf");
  } else if (process.platform === "darwin") {
    candidates.push("Arial Bold.ttf", "Arial.ttf", "Helvetica.ttc");
  } else {
    candidates.push(
      "DejaVuSans-Bold.ttf",
      "DejaVuSans.ttf",
      "truetype/dejavu/DejaVuSans.ttf",
    );
  }
  for (const c of candidates) {
    const p = join(fontsDir, c);
    if (existsSync(p)) return p;
  }
  // Fall back to the first candidate path even if we couldn't stat it.
  return join(fontsDir, candidates[0]!);
}
