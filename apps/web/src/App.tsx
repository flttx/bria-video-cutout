import useProcessing from "./useProcessing";
import GuidedTour, { type TourStep } from "./GuidedTour";
import { api, parseResponse } from "./api";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

type Mode = "auto" | "prompt" | "points";
type PointType = "positive" | "negative";
type Mark = { x: number; y: number; type: PointType; atSeconds: number };
type Meta = { width: number; height: number; duration: number };
type Color = { name: string; label: string; hex: string };

const COLORS: Color[] = [
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
];

const MODES: { id: Mode; label: string; buttonLabel: string; detail: string; limits: string }[] = [
  { id: "auto", label: "自动识别前景", buttonLabel: "自动识别", detail: "保留画面中的整体前景", limits: "最长 60 秒 · 输入尺寸最高 16000 × 16000" },
  { id: "prompt", label: "文字描述目标", buttonLabel: "文字描述", detail: "用文字说明要保留的对象", limits: "最长 5 秒 · Bria 遮罩输入最高 750p" },
  { id: "points", label: "点选画面目标", buttonLabel: "点选目标", detail: "正点保留对象，负点排除对象", limits: "最长 5 秒 · Bria 遮罩输入最高 750p" },
];

function colorLabel(name: string): string {
  return COLORS.find(color => color.name === name)?.label ?? name;
}

function formatTime(time: number): string {
  if (!Number.isFinite(time)) return "00:00";
  const secs = Math.floor(time);
  return String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
}

export default function App() {
  const viewerRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);

  const [preview, setPreview] = useState<"source" | "result">("source");
  const showResult = useCallback(() => {
    // Do not leave keyboard focus inside the source panel when completion hides it.
    if (document.getElementById("preview-source")?.contains(document.activeElement)) {
      document.getElementById("tab-result")?.focus({ preventScroll: true });
    }
    setPreview("result");
  }, []);
  const showSource = useCallback(() => {
    setPreview("source");
    document.getElementById("tab-source")?.focus({ preventScroll: true });
  }, []);
  const [processing, setProcessing] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [uploadedVideoId, setUploadedVideoId] = useState<string | null>(null);
  const [compatiblePreview, setCompatiblePreview] = useState(false);
  const previewRequest = useRef(false);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [fileError, setFileError] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [mode, setMode] = useState<Mode>("auto");
  const [guideMode,setGuideMode]=useState<Mode|null>(null);
  const [prompt, setPrompt] = useState("");
  const [selectedColor, setSelectedColor] = useState("White");
  const [pointType, setPointType] = useState<PointType>("positive");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const flow = useProcessing({file:videoFile,videoId:uploadedVideoId,videoReady:!compatiblePreview||!!uploadedVideoId&&!preparingPreview,duration:meta?.duration??0,mode,prompt,points:marks,color:selectedColor,onBusy:setProcessing,onResultSettled:showResult,view:preview,onEditSource:showSource,colorLabel});
  const apiState = flow.apiState;
  const exportMeta = flow.editingResult ? flow.sourceMeta : meta;

  useEffect(() => {
    // Hidden videos stay mounted to preserve the source and its annotations, but must not keep playing.
    viewerRef.current?.querySelectorAll("video").forEach(video => video.pause());
  }, [preview]);

  const background = COLORS.find((c) => c.name === selectedColor) ?? COLORS[0]!;
  const selectedMode = MODES.find((item) => item.id === mode)!;

  const startGuide=useCallback((targetMode:Mode)=>{
    setMode(targetMode);setPreview("source");setGuideMode(targetMode);videoRef.current?.pause();
  },[]);
  const closeGuide=useCallback(()=>{
    if(guideMode)try{localStorage.setItem(`bria-cutout.guide.${guideMode}.v1`,"1");}catch{/* The guide can still be reopened during this session. */}
    setGuideMode(null);
  },[guideMode]);
  useEffect(()=>{
    let seen=false;try{seen=localStorage.getItem("bria-cutout.guide.auto.v1")==="1";}catch{/* Continue without persisted guide state. */}
    if(seen)return;
    const timer=window.setTimeout(()=>startGuide("auto"),450);
    return()=>window.clearTimeout(timer);
  },[startGuide]);
  const guideSteps=useMemo<TourStep[]>(()=>{
    if(guideMode==="prompt")return [
      {target:'[data-tour="mode"]',title:"选择文字描述",body:"用简短明确的文字说明要保留的对象。若画面里有多个相似对象，文字描述可能会同时选中它们。"},
      {target:'[data-tour="prompt"]',title:"写清目标特征",body:"例如“穿红色外套的人”或“画面中央的白色汽车”。文字描述模式每段最多处理 5 秒。"},
      {target:'[data-tour="source"]',title:"导入并检查视频",body:"点击或拖入 Bria 支持的视频。系统会读取时长；超过 5 秒时需要先裁选处理片段。"},
      {target:'[data-tour="background"]',title:"选择成品背景",body:"选择纯色背景。尺寸和帧率会跟随原视频，完成后可预览并下载 MP4。"},
      {target:'[data-tour="start"]',title:"提交并跟踪进度",body:"点击开始后任务会出现在任务记录中。上传显示真实进度，Bria 阶段显示当前状态。"},
      {target:'[data-tour="task-history"]',title:"查看任务记录",body:"任务记录会显示处理阶段和进度。完成后点击任务上的“预览视频”打开弹窗，也可直接下载成品。"},
    ];
    if(guideMode==="points")return [
      {target:'[data-tour="mode"]',title:"选择点选目标",body:"暂停视频，用“＋保留”标记目标，再用“－排除”修正误选区域。"},
      {target:'[data-tour="source"]',title:"导入并定位视频",body:"选择视频并暂停在目标清楚的一帧。点选模式每段最多处理 5 秒。"},
      {target:'[data-tour="points"]',title:"标记保留与排除区域",body:"先用“＋保留”点选主体；有误选区域时切换“－排除”。所有标记需在同一帧，可撤销或清除。"},
      {target:'[data-tour="background"]',title:"选择成品背景",body:"标记只影响抠图目标，背景颜色在这里选择。输出尺寸和帧率跟随原视频。"},
      {target:'[data-tour="start"]',title:"提交并跟踪进度",body:"至少添加一个保留标记后提交。处理进度会显示在任务记录中。"},
      {target:'[data-tour="task-history"]',title:"查看任务记录",body:"这里显示任务状态和处理进度。完成后可打开成品预览弹窗或下载视频，不会替换当前导出结果。"},
    ];
    if(guideMode==="auto")return [
      {target:'[data-tour="mode"]',title:"自动识别前景",body:"自动识别会尝试保留画面中的整体前景，适合人物、宠物或主体轮廓明显的素材。"},
      {target:'[data-tour="source"]',title:"导入并检查视频",body:"点击或拖入 Bria 支持的视频。自动识别每段最多处理 60 秒；更长的视频需要先裁选片段。"},
      {target:'[data-tour="background"]',title:"选择成品背景",body:"选择纯色背景。完成后可以先预览结果，再下载 MP4。"},
      {target:'[data-tour="cache"]',title:"保留透明抠图缓存",body:"开启后可在本机重新合成不同背景，不用再次调用 Bria；缓存会占用本机磁盘。"},
      {target:'[data-tour="start"]',title:"开始处理",body:"提交后会调用 Bria。上传阶段显示真实百分比，之后按排队、处理、导出等状态更新。"},
      {target:'[data-tour="task-history"]',title:"跟踪任务和下载成品",body:"任务记录会自动展开并显示处理状态。完成后可直接打开预览弹窗或下载成品；刷新页面后记录仍保留。"},
    ];
    return [];
  },[guideMode]);

  useEffect(() => {
    if (!videoFile) {
      setVideoUrl("");
      return;
    }
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fittedVideo = useMemo(() => {
    if (!meta) return null;
    const scale = Math.min(stageSize.width / meta.width, stageSize.height / meta.height);
    const width = meta.width * scale;
    const height = meta.height * scale;
    return { left: (stageSize.width - width) / 2, top: (stageSize.height - height) / 2, width, height };
  }, [meta, stageSize]);

  function acceptFile(file: File) {
    const extensionSupported = /\.(mp4|m4v|mov|webm|avi|gif)$/i.test(file.name);
    const mimeSupported = ["video/mp4", "video/x-m4v", "video/quicktime", "video/webm", "video/x-msvideo", "video/avi", "image/gif"].includes(file.type);
    if (!extensionSupported && !mimeSupported) {
      setFileError("请选择 Bria API 支持的 MP4、MOV、WebM、AVI 或 GIF 文件。");
      return;
    }
    if (file.size > 1_000_000_000) {
      setFileError("文件超过 1GB Bria 上传限制；请先压缩或裁剪。");
      return;
    }
    setFileError("");
    setUploadedVideoId(null);
    setPreviewUrl("");
    setCompatiblePreview(/\.(avi|gif)$/i.test(file.name) || !file.type.startsWith("video/"));
    previewRequest.current = false;
    setPreview("source");
    setVideoFile(file);
    setMeta(null);
    setMarks([]);
    setCurrentTime(0);
    setIsPlaying(false);
    if (/\.(avi|gif)$/i.test(file.name) || !file.type.startsWith("video/")) void prepareCompatiblePreview(file);
  }

  function onChooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) acceptFile(file);
    event.currentTarget.value = "";
  }

  function onDropzoneDragEnter(event: DragEvent<HTMLDivElement>) {
    if (videoUrl) return;
    event.preventDefault();
    if (processing || preparingPreview) return;
    dragDepth.current += 1;
    setIsDragOver(true);
  }

  function onDropzoneDragOver(event: DragEvent<HTMLDivElement>) {
    if (videoUrl) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = processing || preparingPreview ? "none" : "copy";
  }

  function onDropzoneDragLeave(event: DragEvent<HTMLDivElement>) {
    if (videoUrl) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  }

  function onDropzoneDrop(event: DragEvent<HTMLDivElement>) {
    if (videoUrl) return;
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    if (processing || preparingPreview) return;
    const file = event.dataTransfer.files[0];
    if (file) acceptFile(file);
  }

  function onEmptyStageKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!processing && !preparingPreview) inputRef.current?.click();
  }

  async function prepareCompatiblePreview(file: File | null, existingVideoId: string | null = null) {
    if (previewRequest.current) return;
    previewRequest.current = true;
    setPreparingPreview(true);
    try {
      let videoId=existingVideoId;
      if(!videoId) {
        if(!file) throw new Error("无法读取视频文件，请重新选择。");
        const uploadResponse = await fetch("/api/videos", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Cutout-Client": "1", "X-Video-Filename": encodeURIComponent(file.name) }, body: file });
        videoId=(await parseResponse<{id:string;meta:Meta}>(uploadResponse)).id;
      }
      await api(`/api/videos/${videoId}/preview`, {});
      const video=await api<{meta:Meta}>(`/api/videos/${videoId}`);
      setUploadedVideoId(videoId);
      setMeta(video.meta);
      setPreviewUrl(`/api/videos/${videoId}/preview`);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "无法读取此视频，请检查文件格式与编码。");
      setVideoFile(null);
      setMeta(null);
    } finally {
      previewRequest.current = false;
      setPreparingPreview(false);
    }
  }

  function onMetadata() {
    const video = videoRef.current;
    if (!video || previewUrl) return;
    setMeta({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
  }

  function onStageClick(event: MouseEvent<HTMLDivElement>) {
    if (processing || mode !== "points" || !fittedVideo || !videoRef.current || !meta) return;
    if (!videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - bounds.left - fittedVideo.left;
    const dy = event.clientY - bounds.top - fittedVideo.top;
    if (dx < 0 || dy < 0 || dx > fittedVideo.width || dy > fittedVideo.height) return;
    if (marks.length && Math.abs(marks[0]!.atSeconds - videoRef.current.currentTime) > 0.01) {
      setFileError("标注点必须属于同一帧，请回到标注帧，或清空后重新点选。");
      return;
    }
    setFileError("");
    setMarks((previous) => [...previous, {
      x: Math.min(1, Math.max(0, dx / fittedVideo.width)),
      y: Math.min(1, Math.max(0, dy / fittedVideo.height)),
      type: pointType,
      atSeconds: videoRef.current?.currentTime ?? 0,
    }]);
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setIsPlaying(false));
    } else {
      video.pause();
    }
  }

  function onSeek(time: number) {
    const video = videoRef.current;
    if (!video || !meta) return;
    setFileError("");
    video.currentTime = Math.min(meta.duration, Math.max(0, time));
    setCurrentTime(video.currentTime);
  }

  return (
    <main className="app-shell">
      <header className="header">
        <div className="brand"><span className="brand-logo">B</span><div><h1>Video Cutout <span>Lab</span></h1><p>Bria AI 视频抠图工作台</p></div></div>
        <div className="header-tags"><span role="status" className={"status " + apiState}>{apiState === "online" ? "服务已连接" : apiState === "offline" ? "服务未连接" : "正在连接服务"}</span></div>
      </header>

      <div className="workspace">
        <aside className="controls-panel" aria-label="参数设置">
          <fieldset className="settings-fields" disabled={processing}>
          <div className="panel-heading"><h2>参数设置</h2></div>
          <section className="target-device" aria-labelledby="device-title">
            <div className="device-heading"><h3 id="device-title" className="section-label">目标设备</h3><strong>43 寸竖屏设备</strong></div>
            <p className="device-summary">9:16 竖屏 · 本地播放</p>
            <details className="device-details"><summary>设备适配说明</summary><p className="helper">建议使用 9:16 竖屏视频。其他比例按原视频输出，不自动裁剪或拉伸；播放效果以设备实测为准。</p></details>
          </section>
          <div className="control-group"><span id="mode-label" className="section-label">抠图方式</span><div className="mode-list" role="group" aria-labelledby="mode-label" data-tour="mode">
            {MODES.map((item) => <button key={item.id} aria-pressed={mode === item.id} aria-label={`${item.buttonLabel}（${item.label}）`} title={item.detail} className={"mode-option " + (mode === item.id ? "active" : "")} onClick={() => { setMode(item.id); setPreview("source"); setFileError(""); videoRef.current?.pause(); }}><strong>{item.buttonLabel}</strong></button>)}
          </div><div id="mode-limits" className="mode-limits" role="status" aria-live="polite"><p className={flow.durationOverLimit ? "duration-check" : videoFile && meta ? "duration-valid" : "duration-pending"}>{flow.durationStatus}</p><p className="helper">{selectedMode.limits}</p>{mode !== "auto" && <details className="mode-details"><summary>处理说明</summary><p className="helper">本地处理代理最高 1280 × 720，最终按原视频尺寸合成；放大遮罩不会增加细节。</p></details>}</div><div className="mode-guide-row"><button type="button" className="guide-link" onClick={()=>startGuide(mode)}>查看操作引导</button></div></div>
          {flow.editingResult && <p className="helper mode-edit-hint">切换方式可重新设置抠图目标，当前结果仍可查看。</p>}
          <div hidden={flow.editingResult}>
          {mode === "prompt" && <div className="control-group" data-tour="prompt"><label className="section-label" htmlFor="target-prompt">要保留的对象</label><textarea id="target-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="例如：红色汽车、穿蓝色外套的人" /><p className="helper">有多个相似对象时，建议用“点选目标”指定其中一个。</p></div>}
          {mode === "points" && <div className="control-group" data-tour="points"><span className="section-label">标记目标</span><div className="point-tools"><button aria-pressed={pointType === "positive"} className={pointType === "positive" ? "active" : ""} onClick={() => setPointType("positive")}>＋ 保留</button><button aria-pressed={pointType === "negative"} className={pointType === "negative" ? "active" : ""} onClick={() => setPointType("negative")}>－ 排除</button></div><div className="point-count">已标记 {marks.length} 个位置 <button onClick={() => setMarks((items) => items.slice(0, -1))} disabled={!marks.length}>撤销上一步</button><button onClick={() => setMarks([])} disabled={!marks.length}>清除标记</button></div><p className="helper">暂停视频后标记；所有标记须在同一帧和处理片段内。</p>{marks.length > 0 && <button className="outline-button" onClick={() => onSeek(marks[0]!.atSeconds)}>回到标记帧</button>}</div>}

          </div>
          <div className="divider" hidden={flow.editingResult} />
          <div className="control-group" data-tour="background"><div className="group-title"><span className="section-label">背景颜色</span><span className="default-hint">{background.label}</span></div><div className="color-grid">
            {COLORS.map((color) => <button key={color.name} aria-pressed={selectedColor === color.name} className={"color-choice " + (selectedColor === color.name ? "selected" : "")} onClick={() => setSelectedColor(color.name)} aria-label={"背景颜色：" + color.label} title={color.label}><span className="color-swatch" style={{ backgroundColor: color.hex }} /></button>)}
          </div><p className="helper">{flow.editingResult ? "换色后点击“应用修改并导出”。" : "抠图后使用所选背景色。"}</p></div>
          <div className="divider" />
          <div className="control-group source-export-spec" aria-live="polite"><span className="section-label">导出规格</span><p>{exportMeta ? `${Math.ceil(exportMeta.width / 2) * 2} × ${Math.ceil(exportMeta.height / 2) * 2} · 跟随原视频` : "选择视频后显示尺寸"}</p><p className="helper">尺寸、比例和帧率跟随原视频，导出 MP4 / H.264。{exportMeta && (exportMeta.width % 2 || exportMeta.height % 2) ? "为兼容编码，奇数边长会补齐 1 像素。" : ""}</p></div>
          </fieldset>
          {!flow.editingResult && mode === "auto" && <details className="advanced-options" data-tour="cache"><summary>高级设置</summary>{flow.options}</details>}
          {flow.actions}
        </aside>

        <section className="viewer-panel" ref={viewerRef} aria-label="视频预览">
          <div className="panel-heading preview-heading">
            <div className="preview-tabs" role="tablist" aria-label="预览内容">
              {(["source", "result"] as const).map((view) => <button key={view} id={`tab-${view}`} role="tab" aria-selected={preview === view} aria-controls={`preview-${view}`} tabIndex={preview === view ? 0 : -1} onClick={() => setPreview(view)} onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? "source" : event.key === "End" ? "result" : view === "source" ? "result" : "source";
                setPreview(next);
                document.getElementById(`tab-${next}`)?.focus();
              }}>{view === "source" ? "原视频" : "导出结果"}</button>)}
            </div>
            <span className="stage-pill">{preview === "source" ? "源视频" : "当前成品"}</span>
          </div>
          <div id="preview-source" role="tabpanel" aria-labelledby="tab-source" hidden={preview !== "source"} tabIndex={0}>
          <div className={"video-stage " + (!videoUrl ? "is-empty " : "") + (isDragOver && !videoUrl ? "is-drag-over " : "") + (mode === "points" ? "selecting" : "")} ref={stageRef} role={videoUrl ? undefined : "button"} tabIndex={videoUrl ? undefined : processing || preparingPreview ? -1 : 0} aria-label={videoUrl ? undefined : "点击选择或拖放视频文件"} aria-disabled={videoUrl ? undefined : processing || preparingPreview} onClick={videoUrl ? onStageClick : () => { if (!processing && !preparingPreview) inputRef.current?.click(); }} onKeyDown={videoUrl ? undefined : onEmptyStageKeyDown} onDragEnter={onDropzoneDragEnter} onDragOver={onDropzoneDragOver} onDragLeave={onDropzoneDragLeave} onDrop={onDropzoneDrop} style={{ backgroundColor: videoUrl ? background.hex : undefined }} data-tour="source">
            {videoUrl ? (
              <>
                <video ref={videoRef} src={previewUrl || videoUrl} preload="metadata" playsInline onError={() => { if ((videoFile || uploadedVideoId) && !previewUrl) { setCompatiblePreview(true); void prepareCompatiblePreview(videoFile, uploadedVideoId); } }} onLoadedMetadata={onMetadata} onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} />
                {fittedVideo && mode === "points" && marks.map((mark, index) => (
                  <span key={index} className={"marker " + mark.type} style={{ left: (fittedVideo.left + mark.x * fittedVideo.width) + "px", top: (fittedVideo.top + mark.y * fittedVideo.height) + "px" }}>{mark.type === "positive" ? "+" : "−"}</span>
                ))}
                {mode === "points" && <span className="canvas-hint">暂停视频后点选目标；画面外不添加点</span>}
              </>
            ) : (
              <div className="empty-stage"><div className="upload-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg></div><h3>{preparingPreview ? "正在准备视频预览" : isDragOver ? "松开鼠标，添加视频" : "点击或拖入视频"}</h3><p>建议使用 2K / 4K 素材，优先选择 9:16 竖屏视频。<br />MP4、MOV、WebM、AVI、GIF · 最大 1 GB</p><span className="primary-button dropzone-cta" aria-hidden="true">选择视频</span></div>
            )}
          </div>
          <div hidden={!videoUrl}>
          <div className="playback">
            <button className="play-button" aria-label={isPlaying ? "暂停视频" : "播放视频"} disabled={!videoUrl || processing} onClick={togglePlayback}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{isPlaying ? <path d="M6 4h4v16H6zm8 0h4v16h-4z" /> : <path d="m7 4 13 8-13 8z" />}</svg></button>
            <span className="time">{formatTime(currentTime)}</span>
            <input aria-label="播放进度" type="range" min={0} max={Math.max(meta?.duration ?? 0, 0.1)} step="0.01" value={Math.min(currentTime, meta?.duration ?? 0)} onChange={(e) => onSeek(Number(e.target.value))} disabled={!videoUrl || processing} />
            <span className="time">{formatTime(meta?.duration ?? 0)}</span>
          </div>
          <div className="source-info">
            <div><span className="caption">当前视频</span><strong title={videoFile?.name || "尚未选择"}>{videoFile?.name || "尚未选择"}</strong></div>
            <div><span className="caption">视频规格</span><strong>{meta ? meta.width + " × " + meta.height : "—"}</strong></div>
            <button className="outline-button" disabled={processing} onClick={() => inputRef.current?.click()}>更换视频</button>
          </div>
          {flow.clip}
          </div>
          {fileError && <p className="error-text" role="alert">{fileError}</p>}
          <input ref={inputRef} disabled={processing || preparingPreview} hidden aria-label="选择视频文件" type="file" accept=".mp4,.m4v,.mov,.webm,.avi,.gif,video/mp4,video/x-m4v,video/quicktime,video/webm,video/x-msvideo,video/avi,image/gif" onChange={onChooseFile} />
          </div>
          <div id="preview-result" role="tabpanel" aria-labelledby="tab-result" hidden={preview !== "result"} tabIndex={0}>
            {flow.result || <div className="result-empty"><h3>暂无导出结果</h3><p>先选择视频并开始抠图，完成后可在这里预览和下载。</p><button className="outline-button" onClick={() => setPreview("source")}>返回原视频</button></div>}
          </div>
          {flow.history}
        </section>
      </div>
      {guideMode&&<GuidedTour key={guideMode} modeLabel={MODES.find(item=>item.id===guideMode)!.buttonLabel} steps={guideSteps} onClose={closeGuide}/>}

    </main>
  );
}
