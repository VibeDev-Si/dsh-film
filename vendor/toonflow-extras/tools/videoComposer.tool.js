/*! toonflowTool:{"name":"videoComposer","displayName":"本地成片","description":"使用底座 ffmpeg 将工作区视频片段裁剪、拼接、混音并导出 mp4；支持顺序拼接、批量合成和剪辑台Pro时间线合成，不下载 ffmpeg。","prompt":"需要把多个视频片段拼成成片时，优先使用本地成片工具。简单顺序拼接用 compose，多个成片任务用 batchCompose，剪辑台Pro多轨时间线用 timelineCompose。输入和输出路径都必须是当前工作区内的相对路径；不要对 out 输出文件或输出目录调用 ls、stat、access、readFile 做存在性预检查。compose clips 每项可带 start/end；timelineCompose tracks 支持 video/image/audio/subtitle/filter/effect/transition，多层按 zIndex 叠加，可带 xPercent/yPercent/widthPercent/scale/opacity/rotate/volume/fadeIn/fadeOut/timelineStart/duration，subtitle 可带 borderColor/borderWidth/shadowColor/shadowX/shadowY。status 只检查 ffmpeg 是否可用，不下载、不解压、不扫描全盘。compose 或 timelineCompose 返回工作区成片路径后，如果画布已安装剪辑台节点，应把成片路径设置回剪辑台或视频节点作为生成结果。","author":"Dipper","github":"https://github.com/HBAI-Ltd/Toonflow-app","configRules":[{"type":"input","field":"maxParallel","title":"批量合成最大并发数","value":1,"info":"batchCompose 同时运行的 ffmpeg 合成任务数量；默认 1，建议普通电脑不要超过 2。"},{"type":"input","field":"composeTimeoutMinutes","title":"单个合成超时分钟数","value":120,"info":"单个 ffmpeg 合成任务超过该分钟数会自动取消，避免长时间卡住。"},{"type":"input","field":"ffmpegPath","title":"ffmpeg 可执行文件路径","value":"","info":"可选。新版 ToonFlow 会优先使用 context.ffmpeg；旧版或新版不可用时再用这里填写的 ffmpeg.exe。"}],"version":"4.5.1","readme":"# 本地成片\n\n把当前工作区里的多个视频片段裁剪、拼接、混音并导出为 mp4 成片。工具优先使用 ToonFlow 新版 `context.ffmpeg(signal)` 抽象层；宿主未提供时回退到底座/配置的 ffmpeg 可执行文件。\n\n## 使用方式\n\n- `status`：检查 ffmpeg 是否可用，并返回实际运行模式。\n- `compose`：把一组 `clips` 顺序合成为一个 mp4；输出目录不存在时会自动创建。\n- `batchCompose`：通过 `jobs[]` 一次提交多个顺序成片任务。\n- `timelineCompose`：给剪辑台Pro使用的多轨时间线合成，支持 video/image/audio/subtitle/filter/effect/transition 轨道、画中画、图片叠加、字幕坐标、描边阴影、片段淡入淡出和音频混音。\n- `clips[].start` / `clips[].end`：可选，单位秒，用于裁剪单个片段。\n- `audioTracks[]`：可选，按 `timelineStart` 延迟后混入主音频，用于背景音乐、配音或音效。\n- `subtitles[]`：可选，按开始和结束时间把文字烧录进画面；`backgroundColor` 支持 rgba/hex 透明底色，`borderColor`/`borderWidth`/`shadowColor`/`shadowX`/`shadowY` 控制描边和阴影。\n\n## timelineCompose\n\n`timelineCompose` 的 `tracks[]` 支持这些类型：\n\n- `video`：视频层，可带 `timelineStart`、`trimStart`、`duration`、`xPercent`、`yPercent`、`widthPercent`、`scale`、`opacity`、`rotate`、`zIndex`、`volume`、`fadeIn`、`fadeOut`、`audioFadeIn`、`audioFadeOut`。\n- `image`：图片层，可带 `timelineStart`、`duration`、位置、缩放、透明度和层级。\n- `audio`：音频层，可带 `timelineStart`、`trimStart`、`duration`、`volume`。\n- `subtitle`：字幕层，可带 `text`、`timelineStart`、`duration`、`xPercent`、`yPercent`、`fontSize`、`color`、`backgroundColor`、`borderColor`、`borderWidth`、`shadowColor`、`shadowX`、`shadowY`。\n- `filter`：滤镜轨，可带 `filterKind`，当前支持 cinematic/warm/cool/grayscale/soft/noir/vivid。\n- `effect`：特效轨，可带 `effectKind`，当前支持 fadeIn/fadeOut/flash/shake/freeze/speedRamp。\n- `transition`：转场轨，可带 `transitionKind`，当前支持 fadeblack/whiteFlash/crossfade/blurDissolve/zoomBlur/slideLeft/wipe。\n\n## ffmpeg 运行方式\n\n- 新版 ToonFlow：优先 `await context.ffmpeg(signal)`，使用宿主绑定当前工作区的 fluent-ffmpeg 工厂。\n- 旧版 ToonFlow：回退到自动定位或工具配置的 ffmpeg 可执行文件。\n- 任务取消或超时时会终止运行中的 ffmpeg 命令，避免后台残留。\n\n所有输入和输出都限定在当前工作区内。不要把计划生成的输出文件或输出目录当成已有文件去读取或检查。"} */
// @bun
import { mkdir, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, extname, join } from "path";
import { platform } from "os";
import { z } from "toonflow:tool-zod";

const relPath = z.string().min(1).max(4096).refine(
  (value) => !/^[\\/]|[:\u0000-\u001f]/.test(value) && value.split(/[\\/]/).every((part) => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含空路径段或 ..",
);

const configSchema = z.strictObject({
  maxParallel: z.number().int().min(1).max(4).default(1),
  composeTimeoutMinutes: z.number().int().min(1).max(720).default(120),
  ffmpegPath: z.string().trim().max(4096).default(""),
});

const clipSchema = z.strictObject({
  path: relPath,
  label: z.string().trim().max(200).optional(),
  start: z.number().finite().min(0).optional(),
  end: z.number().finite().positive().optional(),
  volume: z.number().finite().min(0).max(4).optional(),
});

const audioTrackSchema = z.strictObject({
  path: relPath,
  label: z.string().trim().max(200).optional(),
  start: z.number().finite().min(0).optional(),
  end: z.number().finite().positive().optional(),
  volume: z.number().finite().min(0).max(4).optional(),
  timelineStart: z.number().finite().min(0).default(0),
});

const subtitleSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  xPercent: z.number().finite().min(0).max(100).default(50),
  yPercent: z.number().finite().min(0).max(100).default(86),
  fontSize: z.number().int().min(12).max(160).default(44),
  color: z.string().trim().max(32).default("white"),
  backgroundColor: z.string().trim().max(64).default("rgba(0,0,0,0.45)"),
  borderColor: z.string().trim().max(64).default("rgba(0,0,0,0.85)"),
  borderWidth: z.number().finite().min(0).max(20).default(0),
  shadowColor: z.string().trim().max(64).default("rgba(0,0,0,0.65)"),
  shadowX: z.number().finite().min(-50).max(50).default(0),
  shadowY: z.number().finite().min(-50).max(50).default(0),
  box: z.boolean().default(true),
});

const timelineClipSchema = z.strictObject({
  path: relPath.optional(),
  label: z.string().trim().max(200).optional(),
  text: z.string().trim().max(1000).optional(),
  timelineStart: z.number().finite().min(0).default(0),
  trimStart: z.number().finite().min(0).default(0),
  duration: z.number().finite().positive().optional(),
  end: z.number().finite().positive().optional(),
  xPercent: z.number().finite().min(0).max(100).default(50),
  yPercent: z.number().finite().min(0).max(100).default(50),
  widthPercent: z.number().finite().min(1).max(300).default(100),
  scale: z.number().finite().min(0.01).max(10).default(1),
  opacity: z.number().finite().min(0).max(1).default(1),
  rotate: z.number().finite().min(-360).max(360).default(0),
  zIndex: z.number().finite().min(-1000).max(1000).default(1),
  volume: z.number().finite().min(0).max(4).default(1),
  fadeIn: z.number().finite().min(0).max(30).default(0),
  fadeOut: z.number().finite().min(0).max(30).default(0),
  audioFadeIn: z.number().finite().min(0).max(30).optional(),
  audioFadeOut: z.number().finite().min(0).max(30).optional(),
  fontSize: z.number().int().min(12).max(160).default(44),
  color: z.string().trim().max(32).default("white"),
  backgroundColor: z.string().trim().max(64).default("rgba(0,0,0,0.45)"),
  borderColor: z.string().trim().max(64).default("rgba(0,0,0,0.85)"),
  borderWidth: z.number().finite().min(0).max(20).default(0),
  shadowColor: z.string().trim().max(64).default("rgba(0,0,0,0.65)"),
  shadowX: z.number().finite().min(-50).max(50).default(0),
  shadowY: z.number().finite().min(-50).max(50).default(0),
  filterKind: z.string().trim().max(80).optional(),
  effectKind: z.string().trim().max(80).optional(),
  transitionKind: z.string().trim().max(80).optional(),
});

const timelineTrackSchema = z.strictObject({
  type: z.enum(["video", "image", "audio", "subtitle", "filter", "effect", "transition"]),
  clips: z.array(timelineClipSchema).max(300).default([]),
});

const timelineCanvasSchema = z.strictObject({
  width: z.number().int().min(240).max(7680).optional(),
  height: z.number().int().min(240).max(7680).optional(),
  fps: z.number().int().min(1).max(120).default(30),
  backgroundColor: z.string().trim().max(64).default("black"),
}).refine((value) => (value.width === undefined) === (value.height === undefined), {
  message: "canvas.width 和 canvas.height 必须同时提供；不提供时会根据首个视频自动判断输出方向",
  path: ["width"],
});

const composeJobBaseSchema = z.strictObject({
  clips: z.array(clipSchema).min(1).max(100).optional(),
  audioTracks: z.array(audioTrackSchema).max(50).default([]),
  subtitles: z.array(subtitleSchema).max(200).default([]),
  out: relPath.optional(),
  width: z.number().int().min(240).max(7680).optional(),
  height: z.number().int().min(240).max(7680).optional(),
  fps: z.number().int().min(1).max(120).default(30),
  crf: z.number().int().min(0).max(51).default(20),
  preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"]).default("veryfast"),
  transition: z.enum(["none", "fadeblack"]).default("fadeblack"),
  transitionSeconds: z.number().finite().min(0).max(2).default(0.35),
  overwrite: z.boolean().default(false),
});

const parametersSchema = composeJobBaseSchema.extend({
  action: z.enum(["status", "compose", "batchCompose", "timelineCompose"]).default("compose"),
  canvas: timelineCanvasSchema.optional(),
  tracks: z.array(timelineTrackSchema).max(20).optional(),
  jobs: z.array(composeJobBaseSchema.extend({
    label: z.string().trim().max(200).optional(),
  }).refine((value) => (value.width === undefined) === (value.height === undefined), {
    message: "width 和 height 必须同时提供；不提供时会根据输入视频自动判断输出方向",
    path: ["width"],
  })).min(1).max(20).optional(),
}).refine((value) => (value.width === undefined) === (value.height === undefined), {
  message: "width 和 height 必须同时提供；不提供时会根据输入视频自动判断输出方向",
  path: ["width"],
});

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getSignal(options) {
  return options?.signal ?? options;
}

function formatResultLink(path) {
  return path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
}

function escapeFilterText(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function enableBetween(start, end) {
  return `between(t\\,${Number(start).toFixed(3)}\\,${Number(end).toFixed(3)})`;
}

function cssColorToFfmpegBoxColor(value, fallback = "black@0.45") {
  const raw = String(value || "").trim();
  const rgba = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgba) {
    const rgb = [rgba[1], rgba[2], rgba[3]].map((part) => Math.max(0, Math.min(255, Number(part || 0))));
    const alpha = Math.max(0, Math.min(1, Number(rgba[4] ?? 1)));
    return `0x${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}@${alpha.toFixed(3)}`;
  }
  const hex = raw.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) {
    const alpha = hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1;
    return `0x${hex[1]}@${alpha.toFixed(3)}`;
  }
  if (/^[a-z]+(?:@[0-9.]+)?$/i.test(raw) || /^0x[0-9a-f]{6}(?:@[0-9.]+)?$/i.test(raw)) return raw;
  return fallback;
}

function cssColorToFfmpegColor(value, fallback = "white") {
  const raw = String(value || "").trim();
  const rgba = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgba) {
    const rgb = [rgba[1], rgba[2], rgba[3]].map((part) => Math.max(0, Math.min(255, Number(part || 0))));
    const alpha = Math.max(0, Math.min(1, Number(rgba[4] ?? 1)));
    return `0x${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}@${alpha.toFixed(3)}`;
  }
  const hex = raw.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) {
    const alpha = hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1;
    return `0x${hex[1]}@${alpha.toFixed(3)}`;
  }
  if (/^[a-z]+(?:@[0-9.]+)?$/i.test(raw) || /^0x[0-9a-f]{6}(?:@[0-9.]+)?$/i.test(raw)) return raw;
  return fallback;
}

function extForPath(path, fallback) {
  const ext = extname(path).replace(/^\./, "").toLowerCase();
  return ext || fallback;
}

function inputName(prefix, index, path, fallback) {
  return `${prefix}${index}.${extForPath(path, fallback)}`;
}

function currentPlatformDir() {
  if (platform() === "win32") return "win32-x64";
  if (platform() === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function executableName(name) {
  return platform() === "win32" ? `${name}.exe` : name;
}

function ffmpegCandidates(cwd, config) {
  const platformDir = currentPlatformDir();
  const binary = executableName("ffmpeg");
  const configured = config.ffmpegPath ? [config.ffmpegPath] : [];
  const roots = [
    process.env.TOONFLOW_FFMPEG_PATH,
    process.env.FFMPEG_PATH,
    join(dirname(cwd), "app", "runtime", "ffmpeg", "bin", binary),
    join(dirname(cwd), "app", "runtime", "ffmpeg", "extract", "ffmpeg-master-latest-win64-gpl", "bin", binary),
    join("D:\\Program Files\\ToonFlow2.0\\stable\\data\\ffmpeg", platformDir, binary),
    join("E:\\ProgramFile\\DuanJu2.0\\app\\runtime\\ffmpeg\\bin", binary),
  ].filter(Boolean);
  return [...configured, ...roots];
}

function findBundledFfmpeg(cwd, config) {
  for (const ffmpegPath of ffmpegCandidates(cwd, config)) {
    if (existsSync(ffmpegPath)) {
      const ffprobePath = ffmpegPath.replace(/ffmpeg(?:\.exe)?$/i, executableName("ffprobe"));
      return {
        ffmpegPath,
        ffprobePath: existsSync(ffprobePath) ? ffprobePath : undefined,
      };
    }
  }
  return { ffmpegPath: undefined, ffprobePath: undefined };
}

async function readStreamText(stream) {
  if (!stream) return "";
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

async function runProcess(command, args, signal, timeoutMs) {
  signal?.throwIfAborted?.();
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  let settled = false;
  let timeout;
  const abort = () => {
    if (!settled) proc.kill();
  };
  if (signal) signal.addEventListener("abort", abort, { once: true });
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      if (!settled) proc.kill();
    }, timeoutMs);
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readStreamText(proc.stdout),
    readStreamText(proc.stderr),
  ]).finally(() => {
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abort);
  });
  if (signal?.aborted) throw new Error("ffmpeg 已取消");
  if (exitCode !== 0) {
    const tail = (stderr || stdout || "").slice(-4000);
    throw new Error(`ffmpeg 执行失败，退出码 ${exitCode}${tail ? `：\n${tail}` : ""}`);
  }
  return { stdout, stderr };
}

async function runBundledFfmpeg(ffmpegPath, args, signal, timeoutMs) {
  if (!ffmpegPath) throw new Error("未找到底座内置 ffmpeg。请确认 FFmpeg 插件已安装，或在工具配置 ffmpegPath 中填写 ffmpeg 可执行文件路径。");
  signal?.throwIfAborted?.();
  await runProcess(ffmpegPath, ["-hide_banner", ...args], signal, timeoutMs);
}

async function getRuntimeFfmpegFactory(context, signal) {
  if (typeof context?.ffmpeg !== "function") return null;
  if (context.__videoComposerFfmpegFactory) return context.__videoComposerFfmpegFactory;
  const factory = await context.ffmpeg(signal);
  if (typeof factory !== "function") throw new Error("宿主 ffmpeg 工厂不可用");
  context.__videoComposerFfmpegFactory = factory;
  return factory;
}

function splitFfmpegArgs(args) {
  const output = args.at(-1);
  if (!output || String(output).startsWith("-")) throw new Error("ffmpeg 参数缺少输出文件");
  const inputs = [];
  const outputOptions = [];
  let inputOptions = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    const token = args[index];
    if (token === "-y" || token === "-hide_banner") continue;
    if (token === "-i") {
      const source = args[index + 1];
      if (!source) throw new Error("ffmpeg 参数缺少输入文件");
      inputs.push({ source, options: inputOptions });
      inputOptions = [];
      index += 1;
      continue;
    }
    if (inputs.length === 0 && ["-ss", "-t", "-loop"].includes(token)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`ffmpeg 参数 ${token} 缺少值`);
      inputOptions.push(token, value);
      index += 1;
      continue;
    }
    outputOptions.push(token);
  }
  return { inputs, outputOptions, output };
}

function waitForFfmpegCommand(command, output, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      try { command.kill?.("SIGKILL"); } catch {}
      finish(new Error("ffmpeg 已取消"));
    };
    if (signal?.aborted) return abort();
    if (signal) signal.addEventListener("abort", abort, { once: true });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        try { command.kill?.("SIGKILL"); } catch {}
        finish(new Error(`ffmpeg 执行超时，已超过 ${Math.round(timeoutMs / 60000)} 分钟`));
      }, timeoutMs);
    }
    command.on("error", (error) => finish(error));
    command.on("end", () => finish());
    command.save(output);
  });
}

async function runRuntimeFfmpeg(context, args, signal, timeoutMs) {
  const factory = await getRuntimeFfmpegFactory(context, signal);
  if (!factory) throw new Error("宿主未提供新版 context.ffmpeg");
  const { inputs, outputOptions, output } = splitFfmpegArgs(args);
  if (!inputs.length) throw new Error("ffmpeg 至少需要一个输入文件");
  let command = factory();
  for (const input of inputs) {
    command = command.input(input.source);
    if (input.options.length) command = command.inputOptions(input.options);
  }
  if (outputOptions.length) command = command.outputOptions(outputOptions);
  await waitForFfmpegCommand(command, output, signal, timeoutMs);
}

async function runFfmpeg(context, args, signal, timeoutMs, config) {
  if (typeof context?.ffmpeg === "function") {
    try {
      await runRuntimeFfmpeg(context, args, signal, timeoutMs);
      return { engine: "context-ffmpeg" };
    } catch (error) {
      if (!context.ffmpegPath) throw error;
      const message = getErrorMessage(error);
      if (/FFMPEG_REQUIRED|需要 FFmpeg|宿主未提供/.test(message)) {
        await runBundledFfmpeg(context.ffmpegPath, args, signal, timeoutMs);
        return { engine: "bundled-ffmpeg-fallback" };
      }
      throw error;
    }
  }
  await runBundledFfmpeg(context.ffmpegPath, args, signal, timeoutMs);
  return { engine: "bundled-ffmpeg", ffmpegPath: context.ffmpegPath };
}

async function resolveWorkspaceFile(resolvePath, rel, name) {
  const abs = await resolvePath(rel, true);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error(`${name} 不是文件：${rel}`);
  return abs;
}

function chooseOutputSize(args, firstVideoMeta) {
  if (args.width && args.height) return { width: args.width, height: args.height, mode: "manual" };
  const width = Number(firstVideoMeta?.width || 0);
  const height = Number(firstVideoMeta?.height || 0);
  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio > 1.15) return { width: 1920, height: 1080, mode: "auto-landscape" };
    if (ratio < 0.87) return { width: 1080, height: 1920, mode: "auto-portrait" };
    return { width: 1080, height: 1080, mode: "auto-square" };
  }
  return { width: 1920, height: 1080, mode: "fallback-landscape" };
}

function chooseTimelineOutputSize(args, firstVideoMeta) {
  if (args.canvas?.width && args.canvas?.height) return { width: args.canvas.width, height: args.canvas.height, mode: "timeline-canvas" };
  return chooseOutputSize(args, firstVideoMeta);
}

async function runtimeFfprobe(context, path, signal) {
  const factory = await getRuntimeFfmpegFactory(context, signal);
  if (!factory || typeof factory.ffprobe !== "function") return null;
  return await new Promise((resolve, reject) => {
    factory.ffprobe(path, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

async function probeVideoMeta(context, path, signal) {
  if (typeof context?.ffmpeg === "function") {
    const info = await runtimeFfprobe(context, path, signal).catch(() => null);
    const stream = Array.isArray(info?.streams) ? info.streams.find((item) => item?.codec_type === "video") : undefined;
    if (stream) {
      return {
        width: Number(stream?.width || 0),
        height: Number(stream?.height || 0),
      };
    }
  }
  if (!context.ffprobePath) return null;
  const { stdout } = await runProcess(context.ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    path,
  ], signal, 15000);
  const info = JSON.parse(stdout || "{}");
  const stream = Array.isArray(info.streams) ? info.streams[0] : undefined;
  return {
    width: Number(stream?.width || 0),
    height: Number(stream?.height || 0),
  };
}

async function probeHasAudio(context, path, signal) {
  if (typeof context?.ffmpeg === "function") {
    const info = await runtimeFfprobe(context, path, signal).catch(() => null);
    if (info) return Array.isArray(info.streams) && info.streams.some((stream) => stream?.codec_type === "audio");
  }
  if (!context.ffprobePath) return true;
  const { stdout } = await runProcess(context.ffprobePath, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_type",
    "-of", "json",
    path,
  ], signal, 15000);
  const info = JSON.parse(stdout || "{}");
  return Array.isArray(info.streams) && info.streams.some((stream) => stream?.codec_type === "audio");
}

function knownClipDuration(clip) {
  const start = Math.max(0, Number(clip.start || 0));
  if (clip.end === undefined) return 0;
  return Math.max(0.05, Number(clip.end) - start);
}

function boundedFade(value, duration) {
  const raw = Math.max(0, Number(value || 0));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, Math.max(0, duration / 2));
}

function normalizeTimelineClip(track, clip, index) {
  const timelineStart = Math.max(0, Number(clip.timelineStart || 0));
  const trimStart = Math.max(0, Number(clip.trimStart || 0));
  const end = clip.end === undefined ? undefined : Number(clip.end);
  const duration = clip.duration !== undefined
    ? Math.max(0.05, Number(clip.duration))
    : end !== undefined
      ? Math.max(0.05, end - trimStart)
      : track.type === "image" || track.type === "subtitle"
        ? 3
        : 5;
  return {
    ...clip,
    type: track.type,
    label: clip.label || clip.text || clip.path || `${track.type}-${index + 1}`,
    timelineStart,
    trimStart,
    duration,
    timelineEnd: timelineStart + duration,
    xPercent: Number(clip.xPercent ?? 50),
    yPercent: Number(clip.yPercent ?? (track.type === "subtitle" ? 86 : 50)),
    widthPercent: Number(clip.widthPercent ?? 100),
    scale: Number(clip.scale ?? 1),
    opacity: Number(clip.opacity ?? 1),
    rotate: Number(clip.rotate ?? 0),
    zIndex: Number(clip.zIndex ?? (track.type === "subtitle" ? 99 : track.type === "image" ? 15 : 1)),
    volume: Number(clip.volume ?? 1),
    fadeIn: Math.max(0, Number(clip.fadeIn ?? 0)),
    fadeOut: Math.max(0, Number(clip.fadeOut ?? 0)),
    audioFadeIn: clip.audioFadeIn === undefined ? undefined : Math.max(0, Number(clip.audioFadeIn)),
    audioFadeOut: clip.audioFadeOut === undefined ? undefined : Math.max(0, Number(clip.audioFadeOut)),
    fontSize: Number(clip.fontSize ?? 44),
    color: clip.color || "white",
    backgroundColor: clip.backgroundColor || "rgba(0,0,0,0.45)",
    borderColor: clip.borderColor || "rgba(0,0,0,0.85)",
    borderWidth: Math.max(0, Number(clip.borderWidth ?? 0)),
    shadowColor: clip.shadowColor || "rgba(0,0,0,0.65)",
    shadowX: Number(clip.shadowX ?? 0),
    shadowY: Number(clip.shadowY ?? 0),
    filterKind: clip.filterKind || undefined,
    effectKind: clip.effectKind || undefined,
    transitionKind: clip.transitionKind || undefined,
  };
}

function collectTimeline(args) {
  const tracks = Array.isArray(args.tracks) ? args.tracks : [];
  const clips = [];
  tracks.forEach((track) => {
    (track.clips || []).forEach((clip, index) => clips.push(normalizeTimelineClip(track, clip, index)));
  });
  return {
    visualClips: clips.filter((clip) => (clip.type === "video" || clip.type === "image") && clip.path),
    audioClips: clips.filter((clip) => clip.type === "audio" && clip.path),
    subtitleClips: clips.filter((clip) => clip.type === "subtitle" && (clip.text || clip.label)),
    effectClips: clips.filter((clip) => ["filter", "effect", "transition"].includes(clip.type)),
  };
}

function buildFilter(clips, audioTracks, subtitles, options) {
  const parts = [];
  const concatInputs = [];
  clips.forEach((clip, index) => {
    const knownDuration = knownClipDuration(clip);
    const fadeDuration = options.transition === "fadeblack" && knownDuration > 0
      ? Math.min(options.transitionSeconds, Math.max(0, knownDuration / 3))
      : 0;
    const fadeOutStart = Math.max(0, knownDuration - fadeDuration);
    let videoFilter = `setpts=PTS-STARTPTS,scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2,fps=${options.fps},format=yuv420p,setsar=1`;
    let audioFilter = "asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,aresample=async=1";
    if (clip.volume !== undefined && clip.volume !== 1) audioFilter += `,volume=${clip.volume.toFixed(3)}`;
    if (fadeDuration > 0) {
      videoFilter += `,fade=t=in:st=0:d=${fadeDuration.toFixed(3)},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}`;
      audioFilter += `,afade=t=in:st=0:d=${fadeDuration.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}`;
    }
    parts.push(`[${index}:v:0]${videoFilter}[v${index}]`);
    parts.push(`[${index}:a:0]${audioFilter}[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  });
  parts.push(`${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[basev][basea]`);

  const audioInputs = ["[basea]"];
  audioTracks.forEach((track, index) => {
    const inputIndex = clips.length + index;
    const delayMs = Math.round(Math.max(0, Number(track.timelineStart || 0)) * 1000);
    let filter = "asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,aresample=async=1";
    if (track.volume !== undefined && track.volume !== 1) filter += `,volume=${track.volume.toFixed(3)}`;
    if (delayMs > 0) filter += `,adelay=${delayMs}|${delayMs}`;
    parts.push(`[${inputIndex}:a:0]${filter}[extraa${index}]`);
    audioInputs.push(`[extraa${index}]`);
  });
  if (audioInputs.length > 1) parts.push(`${audioInputs.join("")}amix=inputs=${audioInputs.length}:duration=first:dropout_transition=0[a]`);
  else parts.push("[basea]anull[a]");

  let videoLabel = "basev";
  subtitles.forEach((subtitle, index) => {
    const nextLabel = index === subtitles.length - 1 ? "v" : `sv${index}`;
    const box = subtitle.box ? `:box=1:boxcolor=${cssColorToFfmpegBoxColor(subtitle.backgroundColor)}:boxborderw=14` : "";
    const border = Number(subtitle.borderWidth || 0) > 0
      ? `:borderw=${Number(subtitle.borderWidth).toFixed(1)}:bordercolor=${cssColorToFfmpegColor(subtitle.borderColor, "black@0.85")}`
      : "";
    const shadow = Number(subtitle.shadowX || 0) !== 0 || Number(subtitle.shadowY || 0) !== 0
      ? `:shadowcolor=${cssColorToFfmpegColor(subtitle.shadowColor, "black@0.65")}:shadowx=${Number(subtitle.shadowX || 0).toFixed(1)}:shadowy=${Number(subtitle.shadowY || 0).toFixed(1)}`
      : "";
    parts.push(`[${videoLabel}]drawtext=text='${escapeFilterText(subtitle.text)}':x=(w-text_w)/2:y=h-150:fontsize=${subtitle.fontSize}:fontcolor=${escapeFilterText(cssColorToFfmpegColor(subtitle.color))}${box}${border}${shadow}:enable='${enableBetween(subtitle.start, subtitle.end)}'[${nextLabel}]`);
    videoLabel = nextLabel;
  });
  if (!subtitles.length) parts.push("[basev]null[v]");
  return parts.join(";");
}

async function composeVideo(context, args, resolvePath, signal, config) {
  signal?.throwIfAborted?.();
  if (!args.clips?.length) throw new Error("compose 需要提供 clips");
  const outputRel = args.out ?? `outputs/composed-${nowStamp()}.mp4`;
  const outputAbs = await resolvePath(outputRel);
  if (extname(outputRel).toLowerCase() !== ".mp4") throw new Error("输出文件必须是 .mp4");
  if (!args.overwrite && existsSync(outputAbs)) throw new Error(`输出文件已存在：${outputRel}。需要覆盖时请设置 overwrite=true`);

  const inputFiles = [];
  const resolvedClips = [];
  for (const [index, clip] of args.clips.entries()) {
    if (clip.end !== undefined && clip.end <= Math.max(0, Number(clip.start || 0))) {
      throw new Error(`片段 ${clip.label || clip.path} 的 end 必须大于 start`);
    }
    const name = inputName("clip", index, clip.path, "mp4");
    inputFiles.push({ name, path: await resolveWorkspaceFile(resolvePath, clip.path, "输入视频") });
    resolvedClips.push({
      ...clip,
      name,
      start: Math.max(0, Number(clip.start || 0)),
      end: clip.end === undefined ? undefined : Number(clip.end),
      duration: knownClipDuration(clip),
      volume: clip.volume ?? 1,
    });
  }

  const resolvedAudioTracks = [];
  for (const [index, track] of (args.audioTracks || []).entries()) {
    if (track.end !== undefined && track.end <= Math.max(0, Number(track.start || 0))) {
      throw new Error(`音频轨 ${track.label || track.path} 的 end 必须大于 start`);
    }
    const name = inputName("audio", index, track.path, "mp3");
    inputFiles.push({ name, path: await resolveWorkspaceFile(resolvePath, track.path, "音频轨输入") });
    resolvedAudioTracks.push({
      ...track,
      name,
      start: Math.max(0, Number(track.start || 0)),
      end: track.end === undefined ? undefined : Number(track.end),
      duration: track.end === undefined ? 0 : Math.max(0.05, Number(track.end) - Math.max(0, Number(track.start || 0))),
      volume: track.volume ?? 1,
      timelineStart: track.timelineStart ?? 0,
    });
  }

  const subtitles = (args.subtitles || []).map((subtitle) => {
    if (subtitle.end <= subtitle.start) throw new Error(`字幕 "${subtitle.text}" 的 end 必须大于 start`);
    return subtitle;
  });

  const firstClipPath = inputFiles.find((file) => file.name === resolvedClips[0]?.name)?.path;
  const firstVideoMeta = firstClipPath ? await probeVideoMeta(context, firstClipPath, signal).catch(() => null) : null;
  const outputSize = chooseOutputSize(args, firstVideoMeta);
  const composeOptions = { ...args, ...outputSize };
  const filter = buildFilter(resolvedClips, resolvedAudioTracks, subtitles, composeOptions);
  const ffmpegArgs = [
    "-y",
    ...resolvedClips.flatMap((clip) => {
      const input = [];
      if (clip.start > 0) input.push("-ss", clip.start.toFixed(3));
      if (clip.duration > 0) input.push("-t", clip.duration.toFixed(3));
      input.push("-i", inputFiles.find((file) => file.name === clip.name).path);
      return input;
    }),
    ...resolvedAudioTracks.flatMap((track) => {
      const input = [];
      if (track.start > 0) input.push("-ss", track.start.toFixed(3));
      if (track.duration > 0) input.push("-t", track.duration.toFixed(3));
      input.push("-i", inputFiles.find((file) => file.name === track.name).path);
      return input;
    }),
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    args.preset,
    "-crf",
    String(args.crf),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputAbs,
  ];

  await mkdir(dirname(outputAbs), { recursive: true });
  if (existsSync(outputAbs) && args.overwrite) await rm(outputAbs, { force: true });
  const ffmpegRun = await runFfmpeg(context, ffmpegArgs, signal, config.composeTimeoutMinutes * 60000);

  const manifestRel = outputRel.replace(/\.mp4$/i, ".compose.json");
  const manifestAbs = await resolvePath(manifestRel);
  const manifest = {
    version: "4.4.0",
    createdAt: new Date().toISOString(),
    output: outputRel,
    engine: ffmpegRun.engine,
    ffmpegPath: ffmpegRun.ffmpegPath || context.ffmpegPath || "",
    settings: {
      width: outputSize.width,
      height: outputSize.height,
      sizeMode: outputSize.mode,
      fps: args.fps,
      crf: args.crf,
      preset: args.preset,
      transition: args.transition,
      transitionSeconds: args.transitionSeconds,
    },
    clips: resolvedClips.map(({ path, label, start, end, duration, volume }) => ({ path, label, start, end, duration, volume })),
    audioTracks: resolvedAudioTracks.map(({ path, label, start, end, duration, volume, timelineStart }) => ({ path, label, start, end, duration, volume, timelineStart })),
    subtitles,
  };
  await writeFile(manifestAbs, JSON.stringify(manifest, null, 2));

  return {
    path: outputRel,
    mimeType: "video/mp4",
    width: outputSize.width,
    height: outputSize.height,
    sizeMode: outputSize.mode,
    manifest: manifestRel,
    clips: manifest.clips,
    audioTracks: manifest.audioTracks,
    subtitles: manifest.subtitles,
  };
}

function buildTimelineFilter(visualClips, audioClips, subtitleClips, effectClips, options) {
  const parts = [];
  const duration = Math.max(0.5, options.duration);
  const background = cssColorToFfmpegColor(options.backgroundColor || "black", "black");
  parts.push(`color=c=${background}:s=${options.width}x${options.height}:r=${options.fps}:d=${duration.toFixed(3)}[canvas0]`);

  let videoLabel = "canvas0";
  visualClips
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.timelineStart - b.timelineStart)
    .forEach((clip, index) => {
      const nextLabel = `layer${index}`;
      const inputLabel = `vl${index}`;
      const targetWidth = Math.max(2, Math.round(options.width * Math.max(1, clip.widthPercent) / 100 * Math.max(0.01, clip.scale)));
      const opacity = Math.max(0, Math.min(1, clip.opacity));
      const rotateRadians = Number(clip.rotate || 0) * Math.PI / 180;
      const fadeIn = boundedFade(clip.fadeIn, clip.duration);
      const fadeOut = boundedFade(clip.fadeOut, clip.duration);
      const visualFilters = [
        `scale=${targetWidth}:-2:force_original_aspect_ratio=decrease`,
        `fps=${options.fps}`,
        "format=rgba",
      ];
      if (fadeIn > 0) visualFilters.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}:alpha=1`);
      if (fadeOut > 0) visualFilters.push(`fade=t=out:st=${Math.max(0, clip.duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1`);
      let filter = visualFilters.join(",");
      if (opacity < 0.999) filter += `,colorchannelmixer=aa=${opacity.toFixed(3)}`;
      if (Math.abs(rotateRadians) > 0.001) filter += `,rotate=${rotateRadians.toFixed(6)}:ow=rotw(iw):oh=roth(ih):c=none`;
      filter += `,setpts=PTS-STARTPTS+${clip.timelineStart.toFixed(3)}/TB`;
      parts.push(`[${clip.inputIndex}:v:0]${filter}[${inputLabel}]`);
      const x = `W*${(clip.xPercent / 100).toFixed(6)}-w/2`;
      const y = `H*${(clip.yPercent / 100).toFixed(6)}-h/2`;
      parts.push(`[${videoLabel}][${inputLabel}]overlay=x='${x}':y='${y}':enable='${enableBetween(clip.timelineStart, clip.timelineEnd)}':shortest=0:format=auto[${nextLabel}]`);
      videoLabel = nextLabel;
    });

  effectClips
    .slice()
    .sort((a, b) => a.timelineStart - b.timelineStart || a.timelineEnd - b.timelineEnd)
    .forEach((clip, index) => {
      const filters = timelineEffectFilters(clip);
      filters.forEach((filter, filterIndex) => {
        const nextLabel = `fx${index}_${filterIndex}`;
        parts.push(`[${videoLabel}]${filter}[${nextLabel}]`);
        videoLabel = nextLabel;
      });
    });

  subtitleClips
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.timelineStart - b.timelineStart)
    .forEach((subtitle, index) => {
      const nextLabel = `sub${index}`;
      const text = escapeFilterText(subtitle.text || subtitle.label || "字幕");
      const x = `w*${(subtitle.xPercent / 100).toFixed(6)}-text_w/2`;
      const y = `h*${(subtitle.yPercent / 100).toFixed(6)}-text_h/2`;
      const box = `:box=1:boxcolor=${cssColorToFfmpegBoxColor(subtitle.backgroundColor)}:boxborderw=14`;
      const border = Number(subtitle.borderWidth || 0) > 0
        ? `:borderw=${Number(subtitle.borderWidth).toFixed(1)}:bordercolor=${cssColorToFfmpegColor(subtitle.borderColor, "black@0.85")}`
        : "";
      const shadow = Number(subtitle.shadowX || 0) !== 0 || Number(subtitle.shadowY || 0) !== 0
        ? `:shadowcolor=${cssColorToFfmpegColor(subtitle.shadowColor, "black@0.65")}:shadowx=${Number(subtitle.shadowX || 0).toFixed(1)}:shadowy=${Number(subtitle.shadowY || 0).toFixed(1)}`
        : "";
      parts.push(`[${videoLabel}]drawtext=text='${text}':x='${x}':y='${y}':fontsize=${subtitle.fontSize}:fontcolor=${escapeFilterText(cssColorToFfmpegColor(subtitle.color))}${box}${border}${shadow}:enable='${enableBetween(subtitle.timelineStart, subtitle.timelineEnd)}'[${nextLabel}]`);
      videoLabel = nextLabel;
    });

  parts.push(`[${videoLabel}]format=yuv420p[v]`);

  const audioInputs = [];
  [...visualClips.filter((clip) => clip.type === "video" && clip.volume > 0 && clip.hasAudio !== false), ...audioClips.filter((clip) => clip.volume > 0 && clip.hasAudio !== false)].forEach((clip, index) => {
    const label = `ta${index}`;
    const delayMs = Math.round(Math.max(0, clip.timelineStart) * 1000);
    let filter = "asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,aresample=async=1";
    const fadeIn = boundedFade(clip.audioFadeIn ?? clip.fadeIn, clip.duration);
    const fadeOut = boundedFade(clip.audioFadeOut ?? clip.fadeOut, clip.duration);
    if (fadeIn > 0) filter += `,afade=t=in:st=0:d=${fadeIn.toFixed(3)}`;
    if (fadeOut > 0) filter += `,afade=t=out:st=${Math.max(0, clip.duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`;
    if (clip.volume !== 1) filter += `,volume=${clip.volume.toFixed(3)}`;
    if (delayMs > 0) filter += `,adelay=${delayMs}|${delayMs}`;
    parts.push(`[${clip.inputIndex}:a:0]${filter}[${label}]`);
    audioInputs.push(`[${label}]`);
  });
  if (audioInputs.length) parts.push(`${audioInputs.join("")}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0[a]`);
  else parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${duration.toFixed(3)}[a]`);

  return parts.join(";");
}

function timelineEffectFilters(clip) {
  const start = Math.max(0, Number(clip.timelineStart || 0));
  const duration = Math.max(0.05, Number(clip.duration || 0.5));
  const end = start + duration;
  const enable = enableBetween(start, end);
  const type = String(clip.type || "");
  const kind = String(clip.filterKind || clip.effectKind || clip.transitionKind || clip.label || "").toLowerCase();
  if (type === "filter") {
    if (kind.includes("grayscale")) return [`hue=s=0:enable='${enable}'`];
    if (kind.includes("warm")) return [`eq=brightness=0.025:contrast=1.04:saturation=1.16:enable='${enable}'`];
    if (kind.includes("cool")) return [`eq=brightness=-0.015:contrast=1.08:saturation=0.92:enable='${enable}'`];
    if (kind.includes("soft")) return [`eq=brightness=0.035:contrast=0.94:saturation=1.04:enable='${enable}'`];
    if (kind.includes("noir")) return [`eq=brightness=-0.05:contrast=1.22:saturation=0.55:enable='${enable}'`];
    if (kind.includes("vivid")) return [`eq=brightness=0.025:contrast=1.12:saturation=1.28:enable='${enable}'`];
    return [`eq=brightness=-0.015:contrast=1.12:saturation=1.04:enable='${enable}'`];
  }
  if (type === "effect") {
    if (kind.includes("fadeout") || kind.includes("fade-out") || kind.includes("淡出")) return [`fade=t=out:st=${start.toFixed(3)}:d=${duration.toFixed(3)}:color=black`];
    if (kind.includes("flash") || kind.includes("闪")) {
      const half = Math.max(0.05, duration / 2);
      return [
        `fade=t=out:st=${start.toFixed(3)}:d=${half.toFixed(3)}:color=white`,
        `fade=t=in:st=${(start + half).toFixed(3)}:d=${half.toFixed(3)}:color=white`,
      ];
    }
    if (kind.includes("shake") || kind.includes("震")) {
      return [`rotate='0.012*sin(70*t)':c=black:enable='${enable}'`];
    }
    if (kind.includes("freeze") || kind.includes("定格")) {
      return [`eq=brightness=-0.025:contrast=1.18:saturation=0.82:enable='${enable}'`];
    }
    if (kind.includes("speed") || kind.includes("ramp") || kind.includes("速度")) {
      return [`unsharp=5:5:0.8:3:3:0.35:enable='${enable}'`];
    }
    if (kind.includes("zoom") || kind.includes("推")) {
      return [`unsharp=7:7:0.9:3:3:0.35:enable='${enable}'`];
    }
    return [`fade=t=in:st=${start.toFixed(3)}:d=${duration.toFixed(3)}:color=black`];
  }
  if (type === "transition") {
    if (kind.includes("white") || kind.includes("白")) {
      const half = Math.max(0.05, duration / 2);
      return [
        `fade=t=out:st=${start.toFixed(3)}:d=${half.toFixed(3)}:color=white`,
        `fade=t=in:st=${(start + half).toFixed(3)}:d=${half.toFixed(3)}:color=white`,
      ];
    }
    if (kind.includes("blur") || kind.includes("模糊") || kind.includes("zoom")) {
      return [`boxblur=luma_radius=8:luma_power=1:enable='${enable}'`];
    }
    if (kind.includes("slide") || kind.includes("wipe") || kind.includes("推") || kind.includes("擦")) {
      const half = Math.max(0.05, duration / 2);
      return [
        `boxblur=luma_radius=4:luma_power=1:enable='${enable}'`,
        `fade=t=out:st=${start.toFixed(3)}:d=${half.toFixed(3)}:color=black`,
        `fade=t=in:st=${(start + half).toFixed(3)}:d=${half.toFixed(3)}:color=black`,
      ];
    }
    const half = Math.max(0.05, duration / 2);
    return [
      `fade=t=out:st=${start.toFixed(3)}:d=${half.toFixed(3)}:color=black`,
      `fade=t=in:st=${(start + half).toFixed(3)}:d=${half.toFixed(3)}:color=black`,
    ];
  }
  return [];
}

async function composeTimeline(context, args, resolvePath, signal, config) {
  signal?.throwIfAborted?.();
  const outputRel = args.out ?? `outputs/timeline-${nowStamp()}.mp4`;
  const outputAbs = await resolvePath(outputRel);
  if (extname(outputRel).toLowerCase() !== ".mp4") throw new Error("输出文件必须是 .mp4");
  if (!args.overwrite && existsSync(outputAbs)) throw new Error(`输出文件已存在：${outputRel}。需要覆盖时请设置 overwrite=true`);

  const timeline = collectTimeline(args);
  if (!timeline.visualClips.length) throw new Error("timelineCompose 需要至少 1 个 video 或 image 片段");

  const inputFiles = [];
  let inputIndex = 0;
  for (const clip of [...timeline.visualClips, ...timeline.audioClips]) {
    const kind = clip.type === "audio" ? "音频轨输入" : clip.type === "image" ? "图片输入" : "视频输入";
    clip.inputIndex = inputIndex;
    clip.absPath = await resolveWorkspaceFile(resolvePath, clip.path, kind);
    if (clip.type === "video" || clip.type === "audio") {
      clip.hasAudio = await probeHasAudio(context, clip.absPath, signal).catch(() => true);
    }
    inputFiles.push(clip);
    inputIndex += 1;
  }

  const firstVideo = timeline.visualClips.find((clip) => clip.type === "video");
  const firstVideoMeta = firstVideo ? await probeVideoMeta(context, firstVideo.absPath, signal).catch(() => null) : null;
  const outputSize = chooseTimelineOutputSize(args, firstVideoMeta);
  const fps = args.canvas?.fps ?? args.fps ?? 30;
  const duration = Math.max(0.5, ...[...timeline.visualClips, ...timeline.audioClips, ...timeline.subtitleClips, ...timeline.effectClips].map((clip) => clip.timelineEnd || 0));
  const filter = buildTimelineFilter(timeline.visualClips, timeline.audioClips, timeline.subtitleClips, timeline.effectClips, {
    ...outputSize,
    fps,
    duration,
    backgroundColor: args.canvas?.backgroundColor || "black",
  });
  const ffmpegArgs = [
    "-y",
    ...inputFiles.flatMap((clip) => {
      const input = [];
      if (clip.type === "image") {
        input.push("-loop", "1", "-t", clip.duration.toFixed(3), "-i", clip.absPath);
        return input;
      }
      if (clip.trimStart > 0) input.push("-ss", clip.trimStart.toFixed(3));
      if (clip.duration > 0) input.push("-t", clip.duration.toFixed(3));
      input.push("-i", clip.absPath);
      return input;
    }),
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    duration.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    args.preset,
    "-crf",
    String(args.crf),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputAbs,
  ];

  await mkdir(dirname(outputAbs), { recursive: true });
  if (existsSync(outputAbs) && args.overwrite) await rm(outputAbs, { force: true });
  const ffmpegRun = await runFfmpeg(context, ffmpegArgs, signal, config.composeTimeoutMinutes * 60000);

  const manifestRel = outputRel.replace(/\.mp4$/i, ".timeline.json");
  const manifestAbs = await resolvePath(manifestRel);
  const manifest = {
    version: "4.4.0",
    createdAt: new Date().toISOString(),
    output: outputRel,
    engine: ffmpegRun.engine === "context-ffmpeg" ? "context-ffmpeg-timeline" : "bundled-ffmpeg-timeline",
    ffmpegPath: ffmpegRun.ffmpegPath || context.ffmpegPath || "",
    settings: {
      width: outputSize.width,
      height: outputSize.height,
      sizeMode: outputSize.mode,
      fps,
      crf: args.crf,
      preset: args.preset,
      duration,
    },
    visualClips: timeline.visualClips.map(({ type, path, label, timelineStart, trimStart, duration, xPercent, yPercent, widthPercent, scale, opacity, rotate, zIndex, volume, fadeIn, fadeOut, audioFadeIn, audioFadeOut }) => ({ type, path, label, timelineStart, trimStart, duration, xPercent, yPercent, widthPercent, scale, opacity, rotate, zIndex, volume, fadeIn, fadeOut, audioFadeIn, audioFadeOut })),
    audioClips: timeline.audioClips.map(({ path, label, timelineStart, trimStart, duration, volume, fadeIn, fadeOut, audioFadeIn, audioFadeOut }) => ({ path, label, timelineStart, trimStart, duration, volume, fadeIn, fadeOut, audioFadeIn, audioFadeOut })),
    subtitles: timeline.subtitleClips.map(({ text, label, timelineStart, duration, xPercent, yPercent, fontSize, color, backgroundColor, borderColor, borderWidth, shadowColor, shadowX, shadowY, zIndex }) => ({ text, label, timelineStart, duration, xPercent, yPercent, fontSize, color, backgroundColor, borderColor, borderWidth, shadowColor, shadowX, shadowY, zIndex })),
    effects: timeline.effectClips.map(({ type, label, timelineStart, duration, filterKind, effectKind, transitionKind }) => ({ type, label, timelineStart, duration, filterKind, effectKind, transitionKind })),
  };
  await writeFile(manifestAbs, JSON.stringify(manifest, null, 2));

  return {
    path: outputRel,
    mimeType: "video/mp4",
    width: outputSize.width,
    height: outputSize.height,
    sizeMode: outputSize.mode,
    duration,
    manifest: manifestRel,
    visualClips: manifest.visualClips,
    audioClips: manifest.audioClips,
    subtitles: manifest.subtitles,
    effects: manifest.effects,
  };
}

function ensureUniqueBatchOutputs(jobs) {
  const seen = new Map();
  jobs.forEach((job, index) => {
    const key = job.out.replaceAll("\\", "/").toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(`批量合成输出路径重复：第 ${previous + 1} 个和第 ${index + 1} 个任务都输出到 ${job.out}`);
    }
    seen.set(key, index);
  });
}

async function composeBatch(context, args, resolvePath, signal, config) {
  if (!args.jobs?.length) throw new Error("batchCompose 需要提供 jobs");
  const stamp = nowStamp();
  const jobs = args.jobs.map((job, index) => ({
    ...job,
    out: job.out ?? `outputs/composed-${stamp}-${String(index + 1).padStart(2, "0")}.mp4`,
  }));
  ensureUniqueBatchOutputs(jobs);

  const maxParallel = Math.min(config.maxParallel, jobs.length);
  const results = new Array(jobs.length);
  let nextIndex = 0;
  const runNext = async () => {
    while (nextIndex < jobs.length) {
      signal?.throwIfAborted?.();
      const index = nextIndex;
      nextIndex += 1;
      const job = jobs[index];
      try {
        const result = await composeVideo(context, job, resolvePath, signal, config);
        results[index] = { ok: true, index, label: job.label, ...result };
      } catch (error) {
        if (signal?.aborted) throw error;
        results[index] = { ok: false, index, label: job.label, out: job.out, error: getErrorMessage(error) };
      }
    }
  };

  await Promise.all(Array.from({ length: maxParallel }, runNext));
  const succeeded = results.filter((result) => result?.ok).length;
  return {
    total: jobs.length,
    succeeded,
    failed: jobs.length - succeeded,
    maxParallel,
    results,
  };
}

export default {
  validateConfig(config) {
    return configSchema.parse(config);
  },
  createTools(context) {
    const { cwd = process.cwd(), config, resolvePath } = context;
    const parsedConfig = configSchema.parse(config);
    const bundledFfmpeg = findBundledFfmpeg(cwd, parsedConfig);
    return [
      {
        name: "videoComposer",
        label: "本地成片",
        description: "检查底座内置 ffmpeg 软件状态，或将工作区视频片段按顺序/多轨时间线合成为 mp4 成片。不下载、不解压、不扫描全盘。",
        promptSnippet: "拼接成片时使用 videoComposer：简单顺序拼接用 compose，剪辑台Pro多轨时间线用 timelineCompose，多个顺序任务用 batchCompose。工具直接调用底座内置 ffmpeg 软件。所有输入输出路径必须是工作区相对路径；timelineCompose 支持 tracks: video/image/audio/subtitle，并支持位置、缩放、透明度、层级、淡入淡出、字幕坐标、字幕描边和阴影。",
        parameters: z.toJSONSchema(parametersSchema, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(executeContext, rawArgs, options) {
          const signal = getSignal(options);
          signal?.throwIfAborted?.();
          const args = parametersSchema.parse(rawArgs);
          const runtime = bundledFfmpeg.ffmpegPath ? bundledFfmpeg : findBundledFfmpeg(cwd, parsedConfig);
          const runContext = { ...context, ...executeContext, ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath };
          const hasRuntimeFfmpeg = typeof context.ffmpeg === "function";
          if (args.action === "status") {
            let runtimeReady = false;
            let runtimeError = "";
            if (hasRuntimeFfmpeg) {
              try {
                await getRuntimeFfmpegFactory(runContext, signal);
                runtimeReady = true;
              } catch (error) {
                runtimeError = getErrorMessage(error);
              }
            }
            const ready = runtimeReady || Boolean(runtime.ffmpegPath);
            const details = {
              ready,
              mode: runtimeReady ? "context-ffmpeg" : runtime.ffmpegPath ? "bundled-ffmpeg" : "missing",
              source: runtimeReady ? "context.ffmpeg" : runtime.ffmpegPath || "missing",
              ffprobe: runtime.ffprobePath || "missing",
              runtimeError,
              message: ready ? "ffmpeg 可用" : "未找到 ffmpeg，请确认 FFmpeg 插件已安装，或在工具配置 ffmpegPath 中填写可执行文件路径",
            };
            return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
          }
          const ready = hasRuntimeFfmpeg || Boolean(runtime.ffmpegPath);
          if (!ready) throw new Error("未找到 ffmpeg，请确认 FFmpeg 插件已安装，或在工具配置 ffmpegPath 中填写可执行文件路径");
          if (args.action === "timelineCompose") {
            const result = await composeTimeline(runContext, args, resolvePath, signal, parsedConfig);
            return {
              content: [{
                type: "text",
                text: `[查看成片](<${formatResultLink(result.path)}>)
工作区文件：${result.path}
输出尺寸：${result.width}x${result.height}
时间线时长：${result.duration.toFixed(2)}s
剪辑清单：${result.manifest}`,
              }],
              details: result,
            };
          }
          if (args.action === "batchCompose") {
            const result = await composeBatch(runContext, args, resolvePath, signal, parsedConfig);
            const lines = result.results.map((item) => {
              const name = item.label ? `${item.index + 1}. ${item.label}` : `${item.index + 1}. ${item.out || item.path}`;
              if (!item.ok) return `失败：${name}\n原因：${item.error}`;
              return `完成：${name}\n[查看成片](<${formatResultLink(item.path)}>)\n工作区文件：${item.path}\n输出尺寸：${item.width}x${item.height}\n剪辑清单：${item.manifest}`;
            });
            return {
              content: [{
                type: "text",
                text: `批量合成完成：${result.succeeded}/${result.total} 成功，${result.failed} 失败；最大并发 ${result.maxParallel}\n\n${lines.join("\n\n")}`,
              }],
              details: result,
            };
          }
          const result = await composeVideo(runContext, args, resolvePath, signal, parsedConfig);
          return {
            content: [{
              type: "text",
              text: `[查看成片](<${formatResultLink(result.path)}>)
工作区文件：${result.path}
输出尺寸：${result.width}x${result.height}
剪辑清单：${result.manifest}`,
            }],
            details: result,
          };
        },
      },
    ];
  },
};
