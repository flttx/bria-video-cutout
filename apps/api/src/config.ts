export type CutoutMode = "auto" | "prompt" | "points";
export type PointType = "positive" | "negative";
export interface MaskPoint {
  x: number;
  y: number;
  type: PointType;
}

export const COLORS = [
  { name: "White", label: "白色", hex: "#FFFFFF" },
  { name: "Black", label: "黑色", hex: "#000000" },
  { name: "Gray", label: "灰色", hex: "#808080" },
  { name: "Red", label: "红色", hex: "#FF0000" },
  { name: "Green", label: "绿色", hex: "#00FF00" },
  { name: "Blue", label: "蓝色", hex: "#0000FF" },
  { name: "Yellow", label: "黄色", hex: "#FFFF00" },
  { name: "Cyan", label: "青色", hex: "#00FFFF" },
  { name: "Magenta", label: "洋红", hex: "#FF00FF" },
  { name: "Orange", label: "橙色", hex: "#FFA500" },
] as const;

export const PUBLIC_CONFIG = {
  modes: [
    { id: "auto", label: "自动识别前景", maxDurationSeconds: 60, nativeOutputResolution: true },
    { id: "prompt", label: "Prompt 指定目标", maxDurationSeconds: 5, maxMaskHeight: 750 },
    { id: "points", label: "点选目标", maxDurationSeconds: 5, maxMaskHeight: 750 },
  ],
  backgroundColors: COLORS,
  defaultBackground: "White",
  outputResolution: "source",
  frameworkOnly: false,
} as const;
