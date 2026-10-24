import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Play, Pause, SkipForward, Volume2, VolumeX, Maximize, Minimize, Settings2, Check, MessageSquare, MessageSquareOff, PictureInPicture2, PanelBottomClose } from "lucide-react";
import { formatDuration } from "../../types";

interface Props {
  videoRef: RefObject<HTMLVideoElement>;
  duration: number;
  active: boolean;
  compact: boolean;
  fullscreen: boolean;
  closeMenuSignal: number;
  qualities: { qn: number; label: string }[];
  selectedQn: number | null;
  rate: number;
  tracks: { lan: string; lan_doc: string; is_ai: boolean }[];
  selectedSubLan: string | null;
  danmakuOn: boolean;
  danmakuCount: number;
  canNext: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onNext: () => void;
  onQuality: (qn: number) => void;
  onRate: (rate: number) => void;
  onSubtitle: (lan: string | null) => void;
  onDanmaku: () => void;
  onFullscreen: () => void;
  onPip: () => void;
  onMini: () => void;
  onMenuChange: (open: boolean) => void;
  preview: (ratio: number) => ReactNode;
}

export function PlayerControls(p: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(p.duration);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [draft, setDraft] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<"quality" | "speed" | "settings" | null>(null);
  const [menuHeight, setMenuHeight] = useState(240);

  useEffect(() => {
    const stage = rootRef.current?.parentElement;
    if (!stage) return;
    const observer = new ResizeObserver(() => setMenuHeight(Math.max(100, stage.clientHeight - 90)));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = p.videoRef.current;
    if (!video) return;
    const sync = () => {
      setTime(video.currentTime || 0);
      setDuration(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : p.duration);
      setPaused(video.paused);
      setVolume(video.volume);
      setMuted(video.muted);
      setBuffered(Array.from({ length: video.buffered.length }, (_, i) => ({ start: video.buffered.start(i), end: video.buffered.end(i) })));
    };
    const events = ["timeupdate", "durationchange", "loadedmetadata", "play", "pause", "ended", "volumechange", "progress", "emptied"];
    events.forEach(event => video.addEventListener(event, sync));
    sync();
    return () => events.forEach(event => video.removeEventListener(event, sync));
  }, [p.videoRef, p.duration]);

  useEffect(() => { setMenu(null); }, [p.closeMenuSignal]);
  useEffect(() => { p.onMenuChange(menu !== null); }, [menu, p.onMenuChange]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);

  const shown = p.active || paused || focused || menu !== null || draft !== null;
  const position = draft ?? time;
  const percent = duration > 0 ? Math.min(100, position / duration * 100) : 0;
  const toggleMenu = (next: typeof menu) => setMenu(prev => prev === next ? null : next);
  const icon = (label: string, action: () => void, content: ReactNode, disabled = false) => (
    <button type="button" className="player-icon" aria-label={label} title={label} onClick={action} disabled={disabled}>{content}</button>
  );
  const choose = (action: () => void) => { action(); setMenu(null); };
  const label = p.qualities.find(q => q.qn === p.selectedQn)?.label ?? "画质";

  return (
    <div ref={rootRef} style={{ "--player-menu-height": `${menuHeight}px` } as React.CSSProperties} className={`player-controls ${shown ? "is-visible" : ""} ${p.compact ? "is-compact" : ""}`}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
      <div className="player-timeline" onPointerLeave={() => setHover(null)}
        onPointerMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
        }}>
        <div className="player-timeline-track" aria-hidden="true">
          {duration > 0 && buffered.map((range, i) => <span className="player-buffered" key={i} style={{ left: `${range.start / duration * 100}%`, width: `${(range.end - range.start) / duration * 100}%` }} />)}
          <span className="player-elapsed" style={{ width: `${percent}%` }} />
        </div>
        {hover !== null && duration > 0 && <div className="player-preview" style={{ left: `clamp(84px, ${hover * 100}%, calc(100% - 84px))` }}>
          {p.preview(hover)}<span>{formatDuration(Math.floor(hover * duration))}</span>
        </div>}
        <input type="range" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 1)}
          aria-label="播放进度" aria-valuetext={`${formatDuration(Math.floor(position))} / ${formatDuration(Math.floor(duration))}`}
          disabled={duration <= 0}
          onPointerDown={() => { draggingRef.current = true; }}
          onChange={e => {
            const value = Number(e.target.value);
            if (draggingRef.current) setDraft(value);
            else p.onSeek(value);
          }}
          onPointerUp={e => { if (draggingRef.current) p.onSeek(Number(e.currentTarget.value)); draggingRef.current = false; setDraft(null); }}
          onPointerCancel={() => { draggingRef.current = false; setDraft(null); }} />
      </div>
      <div className="player-control-row">
        {icon(paused ? "播放（空格）" : "暂停（空格）", p.onTogglePlay, paused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />)}
        {!p.compact && icon("下一集", p.onNext, <SkipForward size={19} />, !p.canNext)}
        <div className="player-volume">
          {icon(muted || volume === 0 ? "取消静音（M）" : "静音（M）", () => { if (p.videoRef.current) p.videoRef.current.muted = !muted; }, muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />)}
          <input aria-label="音量" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
            onChange={e => { const video = p.videoRef.current; if (video) { video.volume = Number(e.target.value); video.muted = false; } }} />
        </div>
        <span className="player-time">{formatDuration(Math.floor(position))}<span> / {formatDuration(Math.floor(duration))}</span></span>
        <div className="player-control-spacer" />
        {!p.compact && <>
          <button className={`player-icon player-danmaku ${p.danmakuOn ? "is-on" : ""}`} type="button" onClick={p.onDanmaku} disabled={!p.danmakuCount}
            aria-label={p.danmakuOn ? "关闭弹幕（D）" : "开启弹幕（D）"} aria-pressed={p.danmakuOn} title={`弹幕 · ${p.danmakuCount} 条（D）`}>
            {p.danmakuOn ? <MessageSquare size={17} /> : <MessageSquareOff size={17} />}<span>弹幕</span>
          </button>
          <div className="player-menu-anchor">
            <button type="button" className="player-text-button" aria-label="选择画质" aria-expanded={menu === "quality"} onClick={() => toggleMenu("quality")} disabled={!p.qualities.length}>{label}</button>
            {menu === "quality" && <div className="player-menu" role="group" aria-label="画质选项">
              <p>画质</p>{p.qualities.map(q => <button type="button" key={q.qn} aria-pressed={q.qn === p.selectedQn} onClick={() => choose(() => p.onQuality(q.qn))}>{q.label}{q.qn === p.selectedQn && <Check size={15} />}</button>)}
            </div>}
          </div>
          <div className="player-menu-anchor">
            <button type="button" className="player-text-button" aria-label="播放速度" aria-expanded={menu === "speed"} onClick={() => toggleMenu("speed")}>{p.rate}×</button>
            {menu === "speed" && <div className="player-menu" role="group" aria-label="倍速选项"><p>播放速度</p>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => <button type="button" key={rate} aria-pressed={rate === p.rate} onClick={() => choose(() => p.onRate(rate))}>{rate === 1 ? "正常 · 1×" : `${rate}×`}{rate === p.rate && <Check size={15} />}</button>)}
            </div>}
          </div>
        </>}
        <div className="player-menu-anchor">
          <button type="button" className="player-icon" aria-label="播放设置" title="播放设置" aria-expanded={menu === "settings"} onClick={() => toggleMenu("settings")}><Settings2 size={18} /></button>
          {menu === "settings" && <div className="player-menu player-settings" role="group" aria-label="播放设置选项">
            <p>字幕</p><button type="button" onClick={() => choose(() => p.onSubtitle(null))}>关闭字幕{!p.selectedSubLan && <Check size={15} />}</button>
            {p.tracks.map(track => <button type="button" key={track.lan} onClick={() => choose(() => p.onSubtitle(track.lan))}>{track.lan_doc}{track.is_ai && <small>AI</small>}{p.selectedSubLan === track.lan && <Check size={15} />}</button>)}
            {!p.tracks.length && <span className="player-menu-empty">该视频暂无可用字幕</span>}
            <div className="player-menu-divider" />
            <button type="button" onClick={() => choose(p.onPip)}><PictureInPicture2 size={16} />系统画中画</button>
            <span className="player-menu-empty">系统画中画仅显示视频画面</span>
            <button type="button" onClick={() => choose(p.onMini)}><PanelBottomClose size={16} />{p.compact ? "还原播放页" : "应用内小窗"}</button>
          </div>}
        </div>
        {icon(p.fullscreen ? "退出全屏（F）" : "全屏（F）", p.onFullscreen, p.fullscreen ? <Minimize size={19} /> : <Maximize size={19} />)}
      </div>
    </div>
  );
}
