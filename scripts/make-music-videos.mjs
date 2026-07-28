#!/usr/bin/env node
/**
 * Batch-produce "Living Cover" music videos: pair each audio file with its
 * cover image (matched by name) and render one video per song.
 *
 * Usage:
 *   node scripts/make-music-videos.mjs <coversDir> <songsDir> [outDir] [--dry] [--style waveform|bars|spectrum]
 *
 * Example:
 *   node scripts/make-music-videos.mjs \
 *     "C:/Users/you/Music/MyAlbum/Covers" \
 *     "C:/Users/you/Music/MyAlbum/Wavs" \
 *     "C:/Users/you/Videos/MyAlbum"
 *
 * Re-running skips videos that already exist, so an interrupted batch resumes.
 */
import { readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { renderMusicVideo, renderMusicVideoReactive } from "@video-editor/engine-ffmpeg";

const AUDIO = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".wma"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const styleIdx = args.indexOf("--style");
const style = styleIdx >= 0 ? args[styleIdx + 1] : "waveform";

const [coversDir, songsDir, outDir = join(process.cwd(), "music-videos")] = positional;
if (!coversDir || !songsDir) {
  console.error("Usage: node scripts/make-music-videos.mjs <coversDir> <songsDir> [outDir] [--dry] [--style waveform|bars|spectrum]");
  process.exit(1);
}

const norm = (s) => s.toLowerCase().replace(/cover/g, "").replace(/[^a-z0-9]/g, "");

const covers = readdirSync(coversDir)
  .filter((f) => IMAGE.has(extname(f).toLowerCase()))
  .map((f) => ({ file: join(coversDir, f), key: norm(basename(f, extname(f))) }));

const songs = readdirSync(songsDir)
  .filter((f) => AUDIO.has(extname(f).toLowerCase()))
  .map((f) => ({ file: join(songsDir, f), name: basename(f, extname(f)), key: norm(basename(f, extname(f))) }));

const pairs = [];
for (const song of songs) {
  const cover =
    covers.find((c) => c.key === song.key) ||
    covers.find((c) => c.key.includes(song.key) || song.key.includes(c.key));
  pairs.push({ song, cover });
}

console.log(`Found ${songs.length} songs, ${covers.length} covers.\n`);
for (const { song, cover } of pairs) {
  console.log(`  ${song.name}  ->  ${cover ? basename(cover.file) : "❌ NO COVER MATCH"}`);
}
console.log("");

if (flags.has("--dry")) {
  console.log("(dry run — nothing rendered)");
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const workDir = join(outDir, ".work");

let done = 0;
for (const { song, cover } of pairs) {
  if (!cover) { console.log(`SKIP ${song.name}: no cover`); continue; }
  const out = join(outDir, `${song.name}.mp4`);
  if (existsSync(out) && statSync(out).size > 0) { console.log(`SKIP ${song.name}: already exists`); done++; continue; }
  process.stdout.write(`\n🎬 ${song.name}${flags.has("--reactive") ? " (reactive)" : ""}\n`);
  let last = -1;
  const onProgress = (p) => {
    const pct = Math.floor(p.fraction * 100);
    if (pct !== last) { last = pct; process.stdout.write(`\r   ${pct}%  ${p.speed ?? ""}   `); }
  };
  const common = { coverPath: cover.file, songPath: song.file, outputPath: out, workDir, onProgress };
  await (flags.has("--reactive")
    ? renderMusicVideoReactive(common)
    : renderMusicVideo({ ...common, effects: { visualizer: style } }));
  console.log(`\n   ✅ ${out}`);
  done++;
}
console.log(`\nDone: ${done}/${pairs.length} videos in ${outDir}`);
