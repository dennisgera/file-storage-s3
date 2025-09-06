import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { validate as validateUUID } from "uuid";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "crypto";
import { uploadVideoToS3 } from "../s3";

const MAX_UPLOAD_SIZE = 1 << 30; // 1GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  // parse videoId as UUID
  if (!validateUUID(videoId)) {
    throw new BadRequestError("Invalid video ID format");
  }
  // authenticate user
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  // get video metadata and check ownership
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new BadRequestError("Video not found");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("You are not the owner of this video");
  }
  // parse uploaded video file
  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Invalid video file");
  }

  // check file size
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(
      `Video file exceeds maximum size of ${MAX_UPLOAD_SIZE} bytes`
    );
  }

  // validate file type
  const mediaType = file.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError(
      `Invalid Content-Type for video: ${file.type}. Only video/mp4 is supported.`
    );
  }
  // generate file key
  let fileKey = randomBytes(32).toString("hex") + ".mp4";

  // save to temporary file
  const tempPath = `/tmp/${fileKey}`;
  try {
    await Bun.write(tempPath, file);
    const aspectRatio = await getVideoAspectRatio(tempPath);

    const processedPath = await processVideoForFastStart(tempPath);
    fileKey = `${aspectRatio}/${fileKey}`;

    // upload to s3
    await uploadVideoToS3(cfg, fileKey, processedPath, mediaType);

    // update video url in db
    video.videoURL = `https://${cfg.s3CfDistribution}/${fileKey}`;
    updateVideo(cfg.db, video);
  } finally {
    // clean up temporary file
    try {
      await Bun.file(tempPath).delete();
    } catch (error) {
      console.error("Error cleaning up temporary file", error);
    }
  }

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const video = Bun.spawn(
    [
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
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

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

export async function processVideoForFastStart(
  filePath: string
): Promise<string> {
  const processedFilePath = filePath + ".processed";
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      filePath,
      "-movflags",
      "faststart",
      "-codec",
      "copy",
      "-f",
      "mp4",
      processedFilePath,
    ],
    { stderr: "pipe" }
  );

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed with exit code ${exitCode}: ${errorText}`);
  }

  return processedFilePath;
}
