#!/usr/bin/env node
/**
 * Renders an album that shares one background (a static cover or an animated
 * loop, optionally watermark-patched) across every track, using the reactive
 * kick-coupled EQ/falling-dust engine, plus a per-song title bar and rotating
 * accent color so each video still feels distinct despite sharing one visual.
 *
 * This is a template — copy it, fill in your own paths/song list below (or
 * point it at your own JSON config), and keep your customized copy out of
 * version control (e.g. in a gitignored `local/` folder) since it will
 * contain your own file paths and unreleased track titles.
 *
 * Usage: node scripts/make-album-videos.mjs [config.json] [outDir] [--dry]
 * Resumable: re-running skips songs that already have a rendered .mp4.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMusicVideoReactive } from "@video-editor/engine-ffmpeg";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const positional = args.filter((a) => !a.startsWith("--"));

// Load config from a JSON file if given, otherwise fall back to this
// placeholder example (edit these to match your own album).
const config = positional[0] && existsSync(positional[0])
  ? JSON.parse(readFileSync(positional[0], "utf8"))
  : {
      albumDir: "C:/path/to/your/album",
      wavsDir: "WAVS",
      // A static image OR a looping animated background — set coverIsVideo accordingly.
      background: "cover.png",
      coverIsVideo: false,
      // Bounding box (in the background's native resolution) of any watermark
      // to blur-patch out; omit if the background has none.
      watermarkBox: undefined, // e.g. { x: 860, y: 960, w: 220, h: 120 }
      songs: [
        { file: "Track One.wav", id: "Track One", title: "TRACK ONE", colors: ["#ff3b30", "#ffb400"] },
        { file: "Track Two.wav", id: "Track Two", title: "TRACK TWO", colors: ["#00d4ff", "#274472"] },
      ],
    };

const albumDir = config.albumDir;
const wavsDir = join(albumDir, config.wavsDir ?? "WAVS");
const bg = join(albumDir, config.background);

const outDir = positional[1] ?? join(albumDir, "Completed");
const workDir = join(outDir, ".work");

mkdirSync(outDir, { recursive: true });

console.log(`Album videos -> ${outDir}\n`);
for (const song of config.songs) {
  const songPath = join(wavsDir, song.file);
  const outputPath = join(outDir, `${song.id}.mp4`);
  if (!existsSync(songPath)) { console.log(`SKIP ${song.id}: source audio not found (${songPath})`); continue; }
  if (existsSync(outputPath)) { console.log(`SKIP ${song.id}: already rendered`); continue; }

  if (dry) { console.log(`Would render [${song.id}] title="${song.title}" colors=${song.colors.join("/")}`); continue; }

  console.log(`\n🎬 ${song.id}`);
  let last = -1;
  await renderMusicVideoReactive({
    coverPath: bg,
    coverIsVideo: Boolean(config.coverIsVideo),
    watermarkBox: config.watermarkBox,
    titleText: song.title,
    accentColors: song.colors,
    songPath,
    outputPath,
    workDir,
    onProgress: (p) => {
      const pct = Math.floor(p.fraction * 100);
      if (pct !== last) { last = pct; process.stdout.write(`\r   ${pct}%  ${p.speed ?? ""}   `); }
    },
  });
  console.log(`\n   ✅ ${outputPath}`);
}
console.log("\nDone.");
