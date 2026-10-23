export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
  }
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: "INTERNAL_ERROR", message: "本地处理失败。请检查磁盘空间和服务运行状态后恢复任务。" };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALID_INPUT", "请求格式不正确。");
  return value as Record<string, unknown>;
}
