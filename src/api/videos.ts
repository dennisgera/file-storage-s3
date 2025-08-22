import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { validate as validateUUID } from "uuid";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";

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
  const fileKey = randomBytes(32).toString("hex") + ".mp4";

  // save to temporary file
  const tempPath = `/tmp/${fileKey}`;
  try {
    await Bun.write(tempPath, file);

    // upload to s3
    await cfg.s3Client
      .file(fileKey, {
        bucket: cfg.s3Bucket,
        region: cfg.s3Region,
      })
      .write(file);

    // update video url in db
    const s3Url = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileKey}`;
    video.videoURL = s3Url;
    updateVideo(cfg.db, video);
  } finally {
    // clean up temporary file
    try {
      await Bun.file(tempPath).delete();
    } catch (error) {
      console.error("Error cleaning up temporary file", error);
    }
  }

  return respondWithJSON(200, null);
}
