import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Camera, Chrome, Circle, Globe2, LoaderCircle, LockKeyhole, MousePointer2, RefreshCw, X } from 'lucide-react';
import type { MouseState, PageInfo, SessionInfo, ViewportState } from '../shared/types';
import { api, eventStream } from './events';

interface Props {
  session: SessionInfo;
  index: number;
  onClose: (id: string) => void;
  onError: (message: string) => void;
  closing: boolean;
  controlled?: boolean;
}

export function BrowserViewer({ session, index, onClose, onError, closing, controlled = false }: Props) {
  const [selectedId, setSelectedId] = useState(session.pages[0]?.id);
  const [focusing, setFocusing] = useState(false);
  const page = session.pages.find(item => item.id === selectedId) ?? session.pages[0];
  const focus = async () => {
    setFocusing(true);
    try { await api(`/sessions/${session.id}/focus`, {}); }
    catch (error) { onError(error instanceof Error ? error.message : 'Không thể hiển thị Chrome.'); }
    finally { setFocusing(false); }
  };
  return <article className={`browser-card cursor-color-${index % 3}`}>
    <div className="browser-card-heading">
      <div className="browser-identity"><span className="browser-number">{String(index + 1).padStart(2, '0')}</span><span><strong>Trình duyệt {String(index + 1).padStart(2, '0')}</strong><small>{session.id.slice(0, 12)}</small></span></div>
      <div className="browser-badges"><button className="chrome-focus-button" onClick={() => void focus()} disabled={focusing} title="Đưa cửa sổ Chrome lên trước">{focusing ? <LoaderCircle size={12} className="spin" /> : <Chrome size={12} />}Hiện Chrome</button><span className={`mode-tag ${session.mode}`}><span className="status-dot" />{controlled ? 'Đang thực thi' : session.mode === 'watch' ? 'Đang theo dõi' : 'Chế độ nhanh'}</span><button className="icon-button subtle" title={controlled ? 'Dừng tác vụ trước khi đóng trình duyệt' : 'Đóng phiên trình duyệt'} aria-label={`Đóng trình duyệt ${index + 1}`} disabled={closing || controlled} onClick={() => onClose(session.id)}>{closing ? <LoaderCircle className="spin" size={15} /> : <X size={15} />}</button></div>
    </div>
    {session.pages.length > 1 && <div className="page-tabs" role="tablist" aria-label="Các trang trình duyệt">{session.pages.map((item, position) => <button key={item.id} role="tab" aria-selected={page?.id === item.id} className={page?.id === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}><Globe2 size={12} />Trang {position + 1}</button>)}</div>}
    {page ? <PageViewer key={page.id} page={page} mode={session.mode} index={index} onError={onError} controlled={controlled} /> : <div className="frame-empty"><LoaderCircle size={22} className="spin" /><strong>Đang mở trang</strong><span>Chrome đang khởi động trên máy backend.</span></div>}
  </article>;
}

function PageViewer({ page, mode, index, onError, controlled }: { page: PageInfo; mode: SessionInfo['mode']; index: number; onError: (message: string) => void; controlled: boolean }) {
  const [address, setAddress] = useState(page.url);
  const [navigating, setNavigating] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [hasFrame, setHasFrame] = useState(!!eventStream.frames.get(page.id));
  const frameRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const coordinatesRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<ViewportState>(page.viewport);
  const positionRef = useRef<MouseState>({ ...page.mouse });
  const initialFrame = useRef(eventStream.frames.get(page.id));
  const dimensionsRef = useRef({ width: 0, height: 0 });
  const seenFrameRef = useRef(hasFrame);
  const inputChainRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);

  useEffect(() => setAddress(page.url), [page.url]);
  useEffect(() => { if (controlled) setInteractive(false); }, [controlled]);
  useEffect(() => { viewportRef.current = page.viewport; }, [page.viewport]);

  useEffect(() => {
    let animation = 0;
    let framePending = initialFrame.current;
    let dirty = true;
    const draw = () => {
      animation = 0;
      if (framePending && frameRef.current) {
        frameRef.current.src = `data:image/jpeg;base64,${framePending.data}`;
        if (framePending.viewport) viewportRef.current = framePending.viewport;
        if (!seenFrameRef.current) { seenFrameRef.current = true; setHasFrame(true); }
        framePending = undefined;
      }
      if (dirty && cursorRef.current && surfaceRef.current) {
        const viewport = viewportRef.current;
        const position = positionRef.current;
        const { width, height } = dimensionsRef.current;
        const x = position.x * width / (viewport.width || 1280);
        const y = position.y * height / (viewport.height || 720);
        cursorRef.current.style.transform = `translate3d(${x}px,${y}px,0)`;
        cursorRef.current.dataset.state = position.status;
        cursorRef.current.style.opacity = seenFrameRef.current ? '1' : '0';
        if (coordinatesRef.current) coordinatesRef.current.textContent = `${Math.round(position.x)}, ${Math.round(position.y)}`;
        if (statusRef.current) {
          const statusLabels: Record<string, string> = { idle: 'chờ', hovering: 'rê chuột', moving: 'di chuyển', pressed: 'nhấn', dragging: 'kéo' };
          statusRef.current.textContent = statusLabels[position.status] ?? position.status;
        }
        dirty = false;
      }
    };
    const schedule = () => { if (!animation) animation = requestAnimationFrame(draw); };
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) dimensionsRef.current = { width: rect.width, height: rect.height };
      dirty = true;
      schedule();
    });
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    positionRef.current = { ...positionRef.current, ...eventStream.cursors.get(page.id) };
    const unsubscribe = eventStream.subscribe(event => {
      if (event.pageId !== page.id) return;
      if (event.type === 'browser:frame') {
        framePending = eventStream.frames.get(page.id);
        dirty = true;
        schedule();
      } else if (event.type.startsWith('mouse:')) {
        positionRef.current = { ...positionRef.current, ...eventStream.cursors.get(page.id) };
        dirty = true;
        schedule();
      }
    });
    schedule();
    return () => { unsubscribe(); observer.disconnect(); cancelAnimationFrame(animation); };
  }, [page.id]);

  // Queue viewer input so moving to the wheel position finishes before scrolling.
  const sendInput = (action: () => Promise<void>) => {
    if (controlled) return;
    if (pendingRef.current >= 4) return;
    pendingRef.current += 1;
    inputChainRef.current = inputChainRef.current.then(action).catch(error => onError(error instanceof Error ? error.message : 'Thao tác trình duyệt thất bại.')).finally(() => { pendingRef.current -= 1; });
  };

  const toBrowser = (clientX: number, clientY: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    const viewport = viewportRef.current;
    return {
      x: Math.min(viewport.width - 1, Math.max(0, (clientX - rect.left) * viewport.width / rect.width)),
      y: Math.min(viewport.height - 1, Math.max(0, (clientY - rect.top) * viewport.height / rect.height)),
    };
  };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !interactive || controlled) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const position = toBrowser(event.clientX, event.clientY);
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportRef.current.height : 1;
      const deltaX = event.deltaX * factor;
      const deltaY = event.deltaY * factor;
      sendInput(async () => {
        await api(`/pages/${page.id}/mouse/move`, position);
        await api(`/pages/${page.id}/mouse/wheel`, { deltaX, deltaY });
      });
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    return () => surface.removeEventListener('wheel', wheel);
  }, [interactive, page.id, controlled]);

  const navigate = async () => {
    if (!address.trim() || controlled) return;
    setNavigating(true);
    try { await api(`/pages/${page.id}/goto`, { url: address.trim() }); }
    catch (error) { onError(error instanceof Error ? error.message : 'Điều hướng thất bại.'); }
    finally { setNavigating(false); }
  };

  const capture = async () => {
    setCapturing(true);
    try {
      const res = await api<{ data: string; url: string }>(`/pages/${page.id}/screenshot`, {});
      if (res?.data) {
        setPreviewUrl(`data:image/jpeg;base64,${res.data}`);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Chụp ảnh màn hình thất bại.');
    } finally {
      setCapturing(false);
    }
  };

  return <>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: 'rgba(59, 130, 246, 0.08)', borderRadius: '6px', fontSize: '12px', color: '#1d4ed8', border: '1px solid rgba(59, 130, 246, 0.2)', marginBottom: '8px' }}>
      <span>🖥️ Cửa sổ Google Chrome thật đang mở trên màn hình Windows. Khung này chỉ phản chiếu lại.</span>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button type="button" onClick={() => void capture()} disabled={capturing} title="Chụp ảnh màn hình trang Chrome này" style={{ cursor: 'pointer', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 10px', fontSize: '11px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          {capturing ? <LoaderCircle size={12} className="spin" /> : <Camera size={12} />}
          Chụp ảnh
        </button>
        <button type="button" onClick={() => void api(`/sessions/${page.sessionId}/focus`, {})} style={{ cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 10px', fontSize: '11px', fontWeight: 600 }}>Hiện Chrome ngoài Desktop</button>
      </div>
    </div>
    <form className="address-bar" onSubmit={event => { event.preventDefault(); void navigate(); }}>
      <LockKeyhole size={13} className="address-lock" />
      <input aria-label={`Địa chỉ trình duyệt ${index + 1}`} spellCheck={false} value={address} onChange={event => setAddress(event.target.value)} placeholder="Nhập địa chỉ URL" disabled={controlled} />
      <button className="icon-button" type="submit" disabled={navigating || !address.trim() || controlled} title="Đi tới địa chỉ" aria-label="Đi tới địa chỉ">{navigating ? <LoaderCircle size={14} className="spin" /> : address === page.url ? <RefreshCw size={13} /> : <ArrowUpRight size={15} />}</button>
    </form>
    <div ref={surfaceRef} className={`browser-surface ${interactive ? 'interactive' : ''}`} style={{ aspectRatio: `${page.viewport.width || 1280} / ${page.viewport.height || 720}` }}
      onClick={event => {
        if (!interactive || !hasFrame || controlled) return;
        const position = toBrowser(event.clientX, event.clientY);
        sendInput(async () => { await api(`/pages/${page.id}/mouse/click`, { ...position, button: 'left' }); });
      }}>
      <img ref={frameRef} className={`browser-frame ${hasFrame ? 'visible' : ''}`} alt={`Trình duyệt trực tiếp ${index + 1} hiển thị ${page.url}`} draggable={false} />
      {!hasFrame && <div className="frame-empty"><Globe2 size={26} /><strong>{mode === 'fast' ? 'Thực thi nhanh' : 'Đang đợi khung hình đầu tiên'}</strong><span>{mode === 'fast' ? 'Khung hình đã tắt để giữ tốc độ tối đa cho phiên này.' : 'Luồng hiển thị trình duyệt sẽ xuất hiện tại đây.'}</span></div>}
      {mode === 'watch' && <div ref={cursorRef} className="agent-cursor" aria-hidden="true" data-state="idle"><svg viewBox="0 0 26 30" width="23" height="27"><path d="M2 2L23 16.5L13 18.4L8.4 27L2 2Z" stroke="#ffffff" strokeWidth="2" strokeLinejoin="round" /></svg><span className="cursor-label">Tác vụ AI {String(index + 1).padStart(2, '0')}</span><span className="cursor-ripple" /></div>}
    </div>
    <div className="browser-footer"><div className="cursor-telemetry"><MousePointer2 size={12} /><span ref={statusRef}>chờ</span><span className="footer-divider" /><span ref={coordinatesRef}>{Math.round(page.mouse.x)}, {Math.round(page.mouse.y)}</span></div><div className="viewer-controls"><span className="viewport-label">{page.viewport.width} × {page.viewport.height}</span><button className={`interact-button ${interactive ? 'active' : ''}`} aria-pressed={interactive} disabled={!hasFrame || controlled} onClick={() => setInteractive(value => !value)} title={controlled ? 'Dừng tác vụ trước khi thao tác thủ công' : 'Bật tương tác click và cuộn trên trình duyệt này'}><Circle size={9} fill={interactive ? 'currentColor' : 'none'} />{controlled ? 'Tác vụ điều khiển' : interactive ? 'Đang tương tác' : 'Tương tác'}</button></div></div>
    {previewUrl && (
      <div className="screenshot-modal" onClick={() => setPreviewUrl(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh', background: '#1e293b', borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#0f172a', color: '#f1f5f9', fontSize: '13px' }}>
            <span>Ảnh chụp màn hình Chrome</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <a href={previewUrl} download={`chrome-screenshot-${Date.now()}.jpg`} className="button secondary small" style={{ fontSize: '12px', padding: '2px 8px', textDecoration: 'none', color: '#93c5fd' }}>Tải ảnh</a>
              <button type="button" onClick={() => setPreviewUrl(null)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><X size={16} /></button>
            </div>
          </div>
          <img src={previewUrl} alt="Ảnh chụp màn hình" style={{ maxWidth: '100%', maxHeight: 'calc(90vh - 40px)', objectFit: 'contain' }} />
        </div>
      </div>
    )}
  </>;
}
