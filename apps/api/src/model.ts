import { COLORS } from "./config.js";
import { AppError, object } from "./errors.js";
import type { CutoutMode, PointType } from "./config.js";

export const MAX_BYTES = 1_000_000_000; // Conservative decimal GB for the documented 1 GB limit.
export const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type ColorName = typeof COLORS[number]["name"];
// Legacy sizes remain readable for saved jobs/exports; new requests follow the source.
export type Resolution = "source" | "2K" | "4K";
export const VIDEO_UPLOAD_TYPES:Record<string,string>={mp4:"video/mp4",mov:"video/quicktime",webm:"video/webm",avi:"video/x-msvideo"};
export interface VideoMeta { width: number; height: number; duration: number; fps: number; hasAudio: boolean; codec: string; pixelFormat: string; frames: number; alpha: boolean; uploadMediaType?:string; containerDuration?:number }
export interface VideoRecord { id: string; meta: VideoMeta; bytes: number; createdAt: string; filename?: string }
export interface Point { x: number; y: number; type: PointType; atSeconds: number }
export interface ExportOptions { color: ColorName; resolution: Resolution }
export interface JobInput extends ExportOptions {
  videoId: string; mode: CutoutMode; prompt: string; points: Point[];
  start: number; end: number; reusable: boolean;
}
export type JobState = "queued" | "preparing" | "uploading" | "submitting" | "processing" | "downloading" | "exporting" | "completed" | "failed";
export interface JobRecord {
  id: string; input: JobInput; state: JobState; createdAt: string; updatedAt: string;
  requestId?: string; submissionAttempted?: boolean; sourceMeta?: VideoMeta;
  artifact?: "alpha" | "mask" | "direct"; artifactReady?: boolean; exportId?: string;
  error?: {code: string; message: string}; canResume?: boolean; warning?: string;
  removedAt?: string;
  transport?: "direct" | "cloud";
  cloudJobId?: string;
}
export interface ExportRecord extends ExportOptions {
  id: string; jobId: string; state: "queued" | "exporting" | "completed" | "failed";
  createdAt: string; meta?: VideoMeta; bytes?: number;
  route?: "direct_bria_mp4" | "alpha_composite" | "mask_composite" | "transcode_only";
  error?: {code: string; message: string};
}
export function validId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new AppError("INVALID_ID", "任务或视频标识不正确。");
  return value;
}
export function exportOptions(value: unknown): ExportOptions {
  const v = object(value);
  if (!COLORS.some(c => c.name === v.color)) {
    throw new AppError("INVALID_EXPORT", "请选择十种预设色之一。");
  }
  if (v.resolution !== undefined && v.resolution !== "source") {
    throw new AppError("INVALID_EXPORT", "导出规格自动跟随原视频，不支持指定分辨率。请刷新页面后重试。");
  }
  return { color: v.color as ColorName, resolution: "source" };
}
export function parseJob(value: unknown, meta: VideoMeta): JobInput {
  const v = object(value);
  const options = exportOptions(v);
  if (v.mode !== "auto" && v.mode !== "prompt" && v.mode !== "points") throw new AppError("INVALID_MODE", "抠图模式无效。");
  const start = v.start, end = v.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > meta.duration + .001) throw new AppError("INVALID_CLIP", "裁选范围须在视频时长内，结束时间必须晚于开始时间。");
  const limit = v.mode === "auto" ? 60 : 5;
  if (end - start > limit + .0001) throw new AppError("DURATION_LIMIT", `当前模式最多处理 ${limit} 秒，请缩短裁选范围。`);
  const prompt = typeof v.prompt === "string" ? v.prompt.trim() : "";
  if (v.mode === "prompt" && (!prompt || prompt.length > 2000)) throw new AppError("INVALID_PROMPT", "请输入目标描述（最多 2000 字符）。");
  const points: Point[] = [];
  if (v.mode === "points") {
    if (!Array.isArray(v.points) || v.points.length < 1 || v.points.length > 100) throw new AppError("INVALID_POINTS", "请添加 1–100 个同一帧的标注点。");
    for (const item of v.points) {
      const p = object(item);
      if (typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1 || (p.type !== "positive" && p.type !== "negative") || typeof p.atSeconds !== "number" || !Number.isFinite(p.atSeconds) || p.atSeconds < start || p.atSeconds >= end) throw new AppError("INVALID_POINTS", "标注点须在画面及裁选片段内。");
      points.push({x:p.x,y:p.y,type:p.type,atSeconds:p.atSeconds});
    }
    if (!points.some(p=>p.type === "positive")) throw new AppError("POSITIVE_REQUIRED", "至少需要一个正点。");
    const frame = Math.floor((points[0]!.atSeconds-start)*meta.fps);
    if (points.some(p=>Math.floor((p.atSeconds-start)*meta.fps)!==frame)) throw new AppError("MIXED_FRAMES", "正负点必须属于同一帧，请清空后在暂停画面重新标注。");
  }
  return {...options, videoId:validId(v.videoId),mode:v.mode,prompt:v.mode === "prompt" ? prompt : "",points,start,end,reusable:v.mode === "auto" ? v.reusable !== false : true};
}
