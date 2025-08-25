import { existsSync, mkdirSync } from "fs";

import type { ApiConfig } from "../config";
import path from "path";
import { randomBytes } from "crypto";

export function ensureAssetsDir(cfg: ApiConfig) {
  if (!existsSync(cfg.assetsRoot)) {
    mkdirSync(cfg.assetsRoot, { recursive: true });
  }
}

export function mediaTypeToExt(mediaType: string) {
  const parts = mediaType.split("/");
  if (parts.length !== 2) {
    return ".bin";
  }
  return `.${parts[1]}`;
}

export function getAssetDiskPath(cfg: ApiConfig, assetPath: string) {
  return path.join(cfg.assetsRoot, assetPath);
}

export function getAssetUrl(cfg: ApiConfig, assetPath: string) {
  return `http://localhost:${cfg.port}/assets/${assetPath}`;
}

export function getAssetPath(mediaType: string) {
  const base = randomBytes(32);
  const id = base.toString("base64url");
  const ext = mediaTypeToExt(mediaType);
  return id + ext;
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const video = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);

  const stdout = await new Response(video.stdout).text();
  const stderr = await new Response(video.stderr).text();
  const exitCode = await video.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed with exit code ${exitCode}: ${stderr}`);
  }

  const result = JSON.parse(stdout);
  const stream = result.streams?.[0];

  if (!stream || !stream.width || !stream.height) {
    throw new Error("Could not extract video dimensions");
  }

  const width = stream.width;
  const height = stream.height;
  const ratio = width / height;

  if (Math.abs(ratio - 16 / 9) < 0.1) {
    return "landscape";
  } else if (Math.abs(ratio - 9 / 16) < 0.1) {
    return "portrait";
  } else {
    return "other";
  }
}
