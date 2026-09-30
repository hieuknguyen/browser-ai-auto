import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Boxes, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleHelp, Clock3, Code2, Cpu, ExternalLink, FileCode2, FlaskConical, Globe2, Layers3, LoaderCircle, Maximize2, Monitor, MousePointer2, Play, Plus, Radio, RotateCcw, ShieldCheck, SquareTerminal, Terminal, X, XCircle, Zap } from 'lucide-react';
import type { AISettings, AITask, AIWorkflow, EngineEvent, ExecutionMode, PageInfo, RunResult, SessionInfo, TestEnvironment } from '../shared/types';
import { BrowserViewer } from './BrowserViewer';
import { GeminiPanel } from './GeminiPanel';
import { Sparkles } from 'lucide-react';
import { api, eventStream } from './events';

interface EngineState { sessions: SessionInfo[]; runs: RunResult[]; environments: TestEnvironment[]; concurrency: number; aiTasks: AITask[]; aiWorkflows: AIWorkflow[]; aiSettings: AISettings }
interface ExampleTest { id?: string; name?: string; [key: string]: unknown }
type View = 'ai' | 'workspace' | 'runs' | 'environments';
type Connection = 'connecting' | 'connected' | 'disconnected';
const emptyState: EngineState = { sessions: [], runs: [], environments: [], concurrency: 0, aiTasks: [], aiWorkflows: [], aiSettings: { provider: 'gemini', configured: false, model: 'gemini-2.5-flash', keySource: 'none' } };
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const shortId = (id?: string) => id?.slice(0, 8) ?? '—';

export function App() {
  const [state, setState] = useState<EngineState>(emptyState);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [view, setView] = useState<View>('ai');
  const [mode, setMode] = useState<ExecutionMode>('watch');
  const [examples, setExamples] = useState<ExampleTest[]>([]);
  const [exampleId, setExampleId] = useState('');
  const [editor, setEditor] = useState('');
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [closing, setClosing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'test' | 'results'>('test');
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [sessionFilter, setSessionFilter] = useState('all');
  const [help, setHelp] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const helpCloseRef = useRef<HTMLButtonElement>(null);
  const reportError = useCallback((message: string) => setError(message), []);
  const updateAITask = useCallback((task: AITask) => setState(current => {
    const previous = current.aiTasks.find(item => item.id === task.id);
    // A POST response may arrive after the live stream already advanced the task.
    if (previous && (previous.steps.length > task.steps.length || (previous.finishedAt && !task.finishedAt) || (task.status === 'queued' && previous.status !== 'queued'))) return current;
    return { ...current, aiTasks: [task, ...current.aiTasks.filter(item => item.id !== task.id)].slice(0, 100) };
  }), []);
  const updateAIWorkflow = useCallback((workflow: AIWorkflow) => setState(current => {
    const previous = current.aiWorkflows.find(item => item.id === workflow.id);
    // Resume starts another attempt, so compare server revisions rather than status rank.
    if (previous && (previous.revision ?? -1) > (workflow.revision ?? -1)) return current;
    if (previous && previous.revision === undefined && workflow.revision === undefined && (
      (workflow.status === 'queued' && previous.status === 'running') ||
      (previous.finishedAt && !workflow.finishedAt && workflow.startedAt === previous.startedAt)
    )) return current;
    return { ...current, aiWorkflows: [workflow, ...current.aiWorkflows.filter(item => item.id !== workflow.id)].slice(0, 100) };
  }), []);
  const updateAISettings = useCallback((settings: AISettings) => setState(current => ({ ...current, aiSettings: settings })), []);

  useEffect(() => {
    let cancelled = false;
    let gotSocketState = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout>;
    let attempts = 0;
    let pendingEvents: EngineEvent[] = [];
    const upsertRun = (run: RunResult) => setState(current => ({ ...current, runs: [run, ...current.runs.filter(item => item.id !== run.id)].slice(0, 100) }));
    const unsubscribe = eventStream.subscribe(event => {
      if (event.type === 'state') {
        gotSocketState = true;
        setState({ sessions: (event.sessions as SessionInfo[]) ?? [], runs: (event.runs as RunResult[]) ?? [], environments: (event.environments as TestEnvironment[]) ?? [], concurrency: Number(event.concurrency ?? 0), aiTasks: (event.aiTasks as AITask[]) ?? [], aiWorkflows: (event.aiWorkflows as AIWorkflow[]) ?? [], aiSettings: (event.aiSettings as AISettings) ?? emptyState.aiSettings });
        setLoading(false);
      } else if (event.type === 'resync') {
        eventStream.reset();
        void api<EngineState>('/status').then(result => { if (!cancelled) setState({ ...emptyState, ...result }); }).catch(err => { if (!cancelled) setError(err.message); });
      } else if (event.type === 'ai:task' && event.task) {
        updateAITask(event.task as AITask);
      } else if (event.type === 'ai:workflow' && event.workflow) {
        updateAIWorkflow(event.workflow as AIWorkflow);
      } else if (event.type === 'ai:settings' && event.settings) {
        updateAISettings(event.settings as AISettings);
      } else if (event.type === 'session:created' && event.session) {
        const session = event.session as SessionInfo;
        setState(current => ({ ...current, sessions: [...current.sessions.filter(item => item.id !== session.id), session] }));
      } else if (event.type === 'session:closed') {
        setState(current => ({ ...current, sessions: current.sessions.filter(session => session.id !== event.sessionId) }));
      } else if ((event.type === 'page:created' || event.type === 'page:updated') && event.page) {
        const page = event.page as PageInfo;
        setState(current => ({ ...current, sessions: current.sessions.map(session => session.id === page.sessionId ? { ...session, pages: [...session.pages.filter(item => item.id !== page.id), page] } : session) }));
      } else if (event.type === 'page:closed') {
        setState(current => ({ ...current, sessions: current.sessions.map(session => ({ ...session, pages: session.pages.filter(page => page.id !== event.pageId) })) }));
      } else if (event.type === 'run:updated' && event.run) upsertRun(event.run as RunResult);
      if (event.type !== 'state' && event.type !== 'browser:frame' && event.type !== 'mouse:moved' && event.type !== 'mouse:wheel' && event.type !== 'page:updated') pendingEvents.push(event);
    });
    const flush = setInterval(() => {
      if (pendingEvents.length) {
        const incoming = pendingEvents;
        pendingEvents = [];
        setEvents(current => [...incoming.reverse(), ...current].slice(0, 60));
      }
    }, 250);
    void api<EngineState>('/status').then(result => { if (!cancelled) { if (!gotSocketState) setState({ ...emptyState, ...result }); setLoading(false); } }).catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });
    void api<{ tests: ExampleTest[] }>('/examples').then(result => {
      if (cancelled) return;
      setExamples(result.tests);
      if (result.tests[0]) { setExampleId('0'); setEditor(JSON.stringify(result.tests[0], null, 2)); }
    }).catch(err => { if (!cancelled) setError(err.message); });
    const connect = () => {
      if (cancelled) return;
      setConnection(attempts ? 'disconnected' : 'connecting');
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socket.onopen = () => { attempts = 0; eventStream.reset(); setConnection('connected'); };
      socket.onmessage = message => {
        try { eventStream.publish(JSON.parse(message.data) as EngineEvent); }
        catch { setError('Không thể đọc dữ liệu cập nhật từ động cơ. Hãy kết nối lại nếu luồng không tự phục hồi.'); }
      };
      socket.onclose = () => {
        if (cancelled) return;
        setConnection('disconnected');
        attempts += 1;
        reconnect = setTimeout(connect, Math.min(1000 * 2 ** (attempts - 1), 8000));
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { cancelled = true; clearTimeout(reconnect); clearInterval(flush); unsubscribe(); socket?.close(); };
  }, []);

  useEffect(() => {
    if (!help) return;
    helpCloseRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelp(false);
      if (event.key === 'Tab') { event.preventDefault(); helpCloseRef.current?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); helpTriggerRef.current?.focus(); };
  }, [help]);

  const perform = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Hành động không thể hoàn thành.'); }
    finally { setBusy(null); }
  };
  const launchDemo = () => perform('demo', async () => { await api('/demo', {}); setView('workspace'); setSessionFilter('all'); });
  const newSession = () => perform('session', async () => {
    const session = await api<SessionInfo>('/sessions', { environment: 'local', mode });
    setState(current => ({ ...current, sessions: current.sessions.some(item => item.id === session.id) ? current.sessions : [...current.sessions, session] }));
    try { await api(`/sessions/${session.id}/focus`, {}); } catch {}
  });
  const runTest = () => perform('run', async () => {
    let test: unknown;
    try { test = JSON.parse(editor); } catch { throw new Error('Kịch bản kiểm thử chứa JSON không hợp lệ. Vui lòng kiểm tra lại trình soạn thảo trước khi chạy.'); }
    const run = await api<RunResult>('/runs', { test, mode });
    setState(current => ({ ...current, runs: [run, ...current.runs.filter(item => item.id !== run.id)] }));
    setSelectedRunId(run.id); setInspectorTab('results');
  });
  const closeSession = async (id: string) => {
    setClosing(current => [...current, id]);
    try { await api(`/sessions/${id}`, undefined, 'DELETE'); setState(current => ({ ...current, sessions: current.sessions.filter(item => item.id !== id) })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Không thể đóng phiên trình duyệt.'); }
    finally { setClosing(current => current.filter(item => item !== id)); }
  };
  const activeRuns = state.runs.filter(run => run.status === 'running' || run.status === 'queued');
  const activeAITasks = state.aiTasks.filter(task => task.status === 'running' || task.status === 'queued');
  const activeAIWorkflows = state.aiWorkflows.filter(workflow => workflow.status === 'running' || workflow.status === 'queued');
  const ownedSessions = new Set([...activeRuns, ...activeAITasks, ...activeAIWorkflows].map(item => item.sessionId).filter((id): id is string => !!id));
  const selectedRun = state.runs.find(run => run.id === selectedRunId) ?? state.runs[0];
  const visibleSessions = state.sessions.filter(session => sessionFilter === 'all' || session.id === sessionFilter);
  const parsedEditor = useMemo(() => { try { return { valid: !!editor && !!JSON.parse(editor), lines: editor.split('\n').length }; } catch { return { valid: false, lines: editor.split('\n').length }; } }, [editor]);
  const unavailable = connection !== 'connected' || !!busy;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('ai'); }} aria-label="Không gian Vector"><div className="brand-mark"><MousePointer2 size={23} fill="currentColor" strokeWidth={1.3} /></div><span>vector<span className="brand-period">.</span></span></a>
      <div className="workspace-switcher"><div className="workspace-avatar">B</div><div><strong>Phòng thí nghiệm</strong><span>Không gian cục bộ</span></div><span className="workspace-local-dot" title="Không gian cục bộ" /></div>
      <span className="nav-heading">KHÔNG GIAN LÀM VIỆC</span>
      <nav aria-label="Điều hướng chính">
        <button className={`nav-item ${view === 'ai' ? 'selected' : ''}`} onClick={() => setView('ai')}><Sparkles size={18} /><span>Điều khiển Gemini</span><span className="ai-nav-badge">AI</span></button>
        <button className={`nav-item ${view === 'workspace' ? 'selected' : ''}`} onClick={() => setView('workspace')}><Monitor size={18} /><span>Khung chiếu gương (Mirror)</span><ChevronRight size={13} /></button>
        <button className={`nav-item ${view === 'runs' ? 'selected' : ''}`} onClick={() => setView('runs')}><FlaskConical size={18} /><span>Lịch sử kiểm thử</span>{state.runs.length > 0 && <span className="nav-count">{state.runs.length}</span>}</button>
        <button className={`nav-item ${view === 'environments' ? 'selected' : ''}`} onClick={() => setView('environments')}><Layers3 size={18} /><span>Môi trường</span></button>
      </nav>
      <div className="sidebar-session-block"><span className="nav-heading">PHIÊN HOẠT ĐỘNG <span>{state.sessions.length}</span></span>{state.sessions.length ? state.sessions.map((session, index) => <button key={session.id} className={`session-nav ${sessionFilter === session.id && view === 'workspace' ? 'selected' : ''}`} onClick={() => { setView('workspace'); setSessionFilter(session.id); }}><span className={`session-color color-${index % 3}`} /><span>Trình duyệt {String(index + 1).padStart(2, '0')}</span><span className="session-mode">{session.mode === 'watch' ? 'theo dõi' : 'nhanh'}</span></button>) : <div className="sidebar-empty"><span className="empty-dot" />Không có trình duyệt nào đang chạy</div>}</div>
      <div className="sidebar-bottom"><div className="isolation-card"><ShieldCheck size={19} /><strong>Thiết kế cô lập</strong><p>Mỗi trình duyệt sở hữu ngữ cảnh, luồng thao tác và phiên làm việc riêng biệt.</p></div><button ref={helpTriggerRef} className="nav-item help-button" onClick={() => setHelp(true)}><CircleHelp size={17} /><span>Hướng dẫn sử dụng</span><ArrowUpRight size={14} /></button><div className="engine-health"><span className={`status-dot ${connection}`} /><span>Động cơ {connection === 'connected' ? 'đã kết nối' : connection === 'connecting' ? 'đang kết nối' : 'đang kết nối lại'}</span><span className="engine-version">v1.0</span></div></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>Không gian</span><ChevronRight size={13} /><strong>{view === 'ai' ? 'Điều khiển Gemini' : view === 'workspace' ? 'Tổng quan' : view === 'runs' ? 'Lịch sử kiểm thử' : 'Môi trường'}</strong></div><div className="topbar-meta"><span className="local-label"><span />Động cơ cục bộ</span><span className="topbar-separator" /><span className="user-avatar" title="Phòng thí nghiệm">PTN</span></div></header>
      <div className="page-content">
        <div className="page-heading"><div><div className="eyebrow"><span />TỰ ĐỘNG HÓA TRÌNH DUYỆT TRỰC QUAN</div><h1>{view === 'ai' ? 'Một yêu cầu. Chrome thực hiện.' : view === 'workspace' ? 'Trình duyệt của bạn. Đồng bộ thời gian thực.' : view === 'runs' ? 'Mọi lượt chạy, đều được ghi nhận.' : 'Quản trị mọi môi trường kiểm thử.'}</h1><p>{view === 'ai' ? 'Kết nối Gemini và giao việc bằng ngôn ngữ tự nhiên. Theo dõi trực tiếp trên Chrome.' : view === 'workspace' ? 'Thực thi thao tác thực. Theo dõi từng chuyển động. Kiểm thử với sự tự tin.' : view === 'runs' ? 'Theo dõi tiến trình thực thi, kiểm tra từng bước và xem lại bằng chứng.' : 'Quản lý mục tiêu kiểm thử và ranh giới bảo mật tập trung tại một nơi.'}</p></div><div className="heading-actions"><button className="button secondary" disabled={unavailable} onClick={() => void newSession()}>{busy === 'session' ? <LoaderCircle size={15} className="spin" /> : <Plus size={16} />}Mở Chrome</button><button className="button primary" disabled={unavailable} onClick={() => void launchDemo()}>{busy === 'demo' ? <LoaderCircle size={15} className="spin" /> : <Play size={14} fill="currentColor" />}Chạy thử nghiệm</button></div></div>

        {error && <div className="error-banner" role="alert"><XCircle size={18} /><div><strong>Cần lưu ý</strong><span>{error}</span></div><button className="icon-button" aria-label="Bỏ qua thông báo lỗi" onClick={() => setError(null)}><X size={16} /></button></div>}
        {connection === 'disconnected' && <div className="connection-banner" role="status"><Radio size={16} />Mất kết nối. Đang kết nối lại với động cơ… Trình duyệt sẽ hiển thị lại khi kết nối thành công.</div>}

        <div className="stats-grid"><Stat icon={<Monitor size={19} />} label="Trình duyệt hoạt động" value={loading ? '—' : state.sessions.length} detail={state.sessions.length ? `${state.sessions.reduce((sum, session) => sum + session.pages.length, 0)} trang đang mở · ngữ cảnh cô lập` : 'Sẵn sàng khi bạn cần'} /><Stat icon={<Activity size={19} />} label="Tác vụ đang chạy" value={loading ? '—' : activeRuns.length + activeAITasks.length} detail={`${activeAITasks.length} tác vụ AI · ${activeRuns.length} kiểm thử JSON`} /><Stat icon={<Cpu size={19} />} label="Công suất xử lý" value={loading || !state.concurrency ? '—' : state.concurrency} detail="Số lượt chạy song song tối đa" /></div>

        {view === 'ai' && <GeminiPanel settings={state.aiSettings} tasks={state.aiTasks} workflows={state.aiWorkflows} sessions={state.sessions} reservedSessions={ownedSessions} connected={connection === 'connected'} onSettings={updateAISettings} onTask={updateAITask} onWorkflow={updateAIWorkflow} onError={reportError} onViewSession={sessionId => { setSessionFilter(sessionId); setView('workspace'); }} />}

        {view === 'workspace' && <>
          <div className={`workspace-layout ${expanded ? 'viewers-expanded' : ''}`}>
            <section className="viewer-section" aria-label="Không gian trình duyệt trực tiếp">
              <div className="section-heading"><div className="section-title"><Monitor size={17} /><h2>Trình duyệt trực tiếp</h2><span className="count-pill">{state.sessions.length}</span></div><div className="section-tools">{state.sessions.length > 1 && <select aria-label="Lọc phiên trình duyệt" className="plain-select" value={state.sessions.some(session => session.id === sessionFilter) ? sessionFilter : 'all'} onChange={event => setSessionFilter(event.target.value)}><option value="all">Tất cả trình duyệt</option>{state.sessions.map((session, index) => <option key={session.id} value={session.id}>Trình duyệt {String(index + 1).padStart(2, '0')}</option>)}</select>}<button className={`icon-button expand-button ${expanded ? 'active' : ''}`} title={expanded ? 'Hiển thị bảng kiểm thử' : 'Mở rộng không gian trình duyệt'} aria-label={expanded ? 'Hiển thị bảng kiểm thử' : 'Mở rộng không gian trình duyệt'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}><Maximize2 size={15} /></button></div></div>
              <div className="viewer-toolbar"><span><span className={`status-dot ${connection}`} />{connection === 'connected' ? 'Kết nối trực tiếp' : 'Đang kết nối động cơ'}</span><span><ShieldCheck size={13} />Chrome hiển thị trực tiếp trên máy</span></div>
              {loading ? <div className="workspace-empty"><LoaderCircle size={28} className="spin" /><h3>Đang kết nối không gian làm việc</h3><p>Đang tải danh sách trình duyệt và cấu hình kiểm thử.</p></div> : visibleSessions.length ? <div className={`browser-grid ${visibleSessions.length === 1 ? 'single' : ''}`}>{visibleSessions.map(session => <BrowserViewer key={session.id} session={session} index={state.sessions.findIndex(item => item.id === session.id)} onClose={id => void closeSession(id)} closing={closing.includes(session.id)} onError={reportError} controlled={ownedSessions.has(session.id)} />)}</div> : <div className="workspace-empty"><div className="empty-illustration" aria-hidden="true"><div className="illustration-browser illustration-back"><div><i /><i /><i /></div><span /></div><div className="illustration-browser illustration-front"><div><i /><i /><i /></div><span /><span /><MousePointer2 size={39} fill="currentColor" strokeWidth={1.2} /></div><div className="illustration-spark"><Zap size={19} fill="currentColor" /></div></div><span className="empty-kicker">BẮT ĐẦU BÀI KIỂM THỬ CỦA BẠN TẠI ĐÂY</span><h3>Góc nhìn rõ ràng cho mọi tương tác.</h3><p>Khởi chạy hai trình duyệt độc lập và xem hai con trỏ ảo cùng lúc thao tác song song.</p><button className="button primary" disabled={unavailable} onClick={() => void launchDemo()}><Play size={13} fill="currentColor" />Bắt đầu bản thử nghiệm<ArrowRight size={15} /></button><span className="empty-footnote">Một động cơ. Hai ngữ cảnh. Thao tác hoàn toàn độc lập.</span></div>}
              <div className="workspace-note"><MousePointer2 size={13} /><span>Khung xem phản chiếu Chrome đang mở trên máy backend. Dùng nút Hiện Chrome để xem cửa sổ trực tiếp.</span><span className="note-badge">THAO TÁC TRÌNH DUYỆT</span></div>
            </section>

            {!expanded && <aside className="inspector" aria-label="Bảng kiểm thử"><div className="inspector-tabs" role="tablist" aria-label="Bảng kiểm thử"><button role="tab" aria-selected={inspectorTab === 'test'} className={inspectorTab === 'test' ? 'active' : ''} onClick={() => setInspectorTab('test')}><FileCode2 size={15} />Kịch bản kiểm thử</button><button role="tab" aria-selected={inspectorTab === 'results'} className={inspectorTab === 'results' ? 'active' : ''} onClick={() => setInspectorTab('results')}><CheckCircle2 size={15} />Kết quả{activeRuns.length > 0 && <span className="tab-live-dot" />}</button></div>
              {inspectorTab === 'test' ? <div className="test-panel"><div className="panel-label-row"><span className="field-label">KỊCH BẢN KIỂM THỬ</span><span className="json-label">JSON</span></div><div className="example-selector"><FileCode2 size={15} /><select aria-label="Tải kịch bản mẫu" value={exampleId} onChange={event => { const value = event.target.value; setExampleId(value); if (examples[Number(value)]) setEditor(JSON.stringify(examples[Number(value)], null, 2)); }}><option value="" disabled>{examples.length ? 'Kịch bản tùy chỉnh' : 'Đang tải kịch bản mẫu…'}</option>{examples.map((example, index) => <option value={index} key={example.id ?? index}>{example.name ?? example.id ?? `Ví dụ ${index + 1}`}</option>)}</select><ChevronDown size={13} /></div><div className="code-editor"><div className="editor-filebar"><span><span />test.json</span><button className="icon-button" title="Định dạng JSON" aria-label="Định dạng JSON" disabled={!parsedEditor.valid} onClick={() => setEditor(JSON.stringify(JSON.parse(editor), null, 2))}><Code2 size={14} /></button></div><div className="editor-body"><div className="line-numbers" aria-hidden="true">{Array.from({ length: parsedEditor.lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea ref={editorRef} aria-label="JSON kịch bản kiểm thử" spellCheck={false} value={editor} onChange={event => { setEditor(event.target.value); setExampleId(''); }} onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); const field = event.currentTarget; const start = field.selectionStart; const end = field.selectionEnd; setEditor(editor.slice(0, start) + '  ' + editor.slice(end)); requestAnimationFrame(() => field.setSelectionRange(start + 2, start + 2)); } if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !unavailable && parsedEditor.valid) { event.preventDefault(); void runTest(); } }} placeholder="Tải kịch bản mẫu hoặc nhập định nghĩa kịch bản kiểm thử…" /></div><div className="editor-status"><span className={parsedEditor.valid ? 'valid' : ''}>{parsedEditor.valid ? <Check size={11} /> : <Circle size={9} />}{editor ? parsedEditor.valid ? 'JSON hợp lệ' : 'Kiểm tra cú pháp JSON' : 'Đang đợi kịch bản'}</span><span>{parsedEditor.lines} dòng</span></div></div>
                <div className="execution-label"><span className="field-label">CHẾ ĐỘ THỰC THI</span><span>{mode === 'watch' ? 'Trực quan + nhịp nhàng' : 'Tốc độ tối đa'}</span></div><div className="mode-toggle" aria-label="Chế độ thực thi"><button className={mode === 'watch' ? 'active' : ''} aria-pressed={mode === 'watch'} onClick={() => setMode('watch')}><Monitor size={14} />Chế độ theo dõi</button><button className={mode === 'fast' ? 'active' : ''} aria-pressed={mode === 'fast'} onClick={() => setMode('fast')}><Zap size={14} />Chế độ nhanh</button></div><button className="button run-button" disabled={unavailable || !parsedEditor.valid} onClick={() => void runTest()}>{busy === 'run' ? <LoaderCircle size={14} className="spin" /> : <Play size={13} fill="currentColor" />}Chạy kiểm thử<span>Ctrl ↵</span></button><p className="run-hint">{mode === 'watch' ? 'Quan sát từng bước với trình duyệt trực tiếp và con trỏ ảo.' : 'Chạy với tốc độ tối đa không qua stream khung hình.'}</p>
              </div> : <div className="results-panel">{state.runs.length > 1 && <select className="run-select" aria-label="Chọn lượt chạy" value={selectedRun?.id ?? ''} onChange={event => setSelectedRunId(event.target.value)}>{state.runs.map(run => <option key={run.id} value={run.id}>{run.name} · {shortId(run.id)}</option>)}</select>}<RunDetails run={selectedRun} /></div>}
            </aside>}
          </div>

          <div className="bottom-grid"><section className="activity-panel"><div className="section-heading"><div className="section-title"><Terminal size={16} /><h2>Nhật ký hoạt động</h2><span className="live-label">TRỰC TIẾP</span></div><button className="text-button" onClick={() => setEvents([])} disabled={!events.length}>Xóa</button></div><EventFeed events={events.slice(0, 8)} /></section><section className="recent-panel"><div className="section-heading"><div className="section-title"><Clock3 size={16} /><h2>Lượt chạy gần đây</h2></div><button className="text-button" onClick={() => setView('runs')}>Xem tất cả<ArrowUpRight size={12} /></button></div>{state.runs.length ? <div className="recent-list">{state.runs.slice(0, 4).map(run => <button key={run.id} className="recent-run" onClick={() => { setSelectedRunId(run.id); setInspectorTab('results'); setExpanded(false); }}><RunIcon status={run.status} /><span><strong>{run.name}</strong><small>{run.environment} · {run.mode === 'watch' ? 'theo dõi' : 'nhanh'} · {shortId(run.id)}</small></span><span className={`result-badge ${run.status}`}>{runStatusText[run.status] ?? run.status}</span></button>)}</div> : <div className="small-empty"><FlaskConical size={24} /><strong>Lịch sử kiểm thử sẽ xuất hiện ở đây</strong><span>Chạy một kịch bản để xem tiến trình các bước và tệp kết quả.</span></div>}</section></div>
        </>}

        {view === 'runs' && <div className="runs-layout"><section className="run-history"><div className="section-heading"><div className="section-title"><FlaskConical size={17} /><h2>Lịch sử kiểm thử</h2><span className="count-pill">{state.runs.length}</span></div><span className="subtle-caption">Phiên làm việc hiện tại</span></div>{state.runs.length ? state.runs.map(run => <button key={run.id} className={`run-row ${selectedRun?.id === run.id ? 'selected' : ''}`} onClick={() => setSelectedRunId(run.id)}><RunIcon status={run.status} /><div><strong>{run.name}</strong><small>{shortId(run.id)} · {run.environment} · {run.mode === 'watch' ? 'theo dõi' : 'nhanh'}</small></div><span className={`result-badge ${run.status}`}>{runStatusText[run.status] ?? run.status}</span><ChevronRight size={15} /></button>) : <div className="workspace-empty compact"><FlaskConical size={32} /><h3>Chưa có lượt chạy kiểm thử nào</h3><p>Hãy chọn một kịch bản trong không gian làm việc để chạy bài kiểm thử đầu tiên.</p><button className="button secondary" onClick={() => setView('workspace')}>Mở không gian làm việc<ArrowRight size={15} /></button></div>}</section><aside className="run-detail-card"><div className="section-heading"><div className="section-title"><Code2 size={17} /><h2>Chi tiết lượt chạy</h2></div></div><RunDetails run={selectedRun} /></aside></div>}

        {view === 'environments' && <section className="environments-grid">{state.environments.length ? state.environments.map(environment => <article className="environment-card" key={environment.name}><div className="environment-heading"><span className="environment-icon"><Globe2 size={23} /></span><span className={`environment-kind ${environment.production ? 'production' : ''}`}>{environment.production ? 'Sản phẩm (Production)' : 'Phát triển (Development)'}</span></div><h2>{environment.name}</h2><p className="environment-url">{environment.baseURL || 'Chưa cấu hình URL cơ sở'}</p><div className="environment-domains"><span className="field-label">TÊN MIỀN ĐƯỢC PHÉP</span><div>{environment.allowedDomains.map(domain => <code key={domain}>{domain}</code>)}</div></div><div className="environment-policy"><ShieldCheck size={16} /><span>{environment.policy?.enabled ? 'Đã bật bảo vệ môi trường sản phẩm' : environment.production ? 'Mục tiêu môi trường sản phẩm' : 'Ngữ cảnh trình duyệt cô lập'}</span></div>{environment.policy?.enabled && <dl className="policy-list"><div><dt>Giới hạn chạy đồng thời</dt><dd>{environment.policy.maxConcurrency}</dd></div><div><dt>Số yêu cầu mỗi phút</dt><dd>{environment.policy.requestsPerMinute}</dd></div><div><dt>Tài khoản kiểm thử</dt><dd>{environment.policy.requireTestAccount ? 'Bắt buộc' : 'Tùy chọn'}</dd></div><div><dt>Hành động bị chặn</dt><dd>{environment.policy.blockedActions.join(', ') || 'Không có'}</dd></div></dl>}</article>) : <div className="workspace-empty"><Globe2 size={30} /><h3>{loading ? 'Đang tải môi trường' : 'Không có môi trường nào khả dụng'}</h3><p>Cấu hình môi trường được cung cấp bởi động cơ hệ thống.</p></div>}</section>}

        <footer className="page-footer"><span><span className="footer-logo">↗</span> VECTOR <span className="footer-separator">/</span> Điều khiển trình duyệt bằng Gemini</span><span><Boxes size={12} />React · Python · Chrome<span className="footer-dot">·</span>Thực thi cục bộ</span></footer>
      </div>
    </main>
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title" onClick={event => event.stopPropagation()}><button ref={helpCloseRef} className="icon-button modal-close" aria-label="Đóng hướng dẫn" onClick={() => setHelp(false)}><X size={19} /></button><span className="guide-icon"><MousePointer2 size={25} /></span><span className="eyebrow">TỔNG QUAN NHANH</span><h2 id="guide-title">Quan sát toàn bộ tương tác.</h2><p>Vector kết nối thao tác trình duyệt thực tế với khung xem trực tiếp, giúp bạn nhìn thấy chính xác những gì bài kiểm thử đang làm.</p><ol><li><strong>Kết nối Gemini</strong><span>Nhập API key ở mục Điều khiển Gemini, lưu cấu hình rồi mô tả công việc. Chrome mở trực tiếp trên máy chạy backend.</span></li><li><strong>Khởi chạy bản thử nghiệm</strong><span>Hai ngữ cảnh trình duyệt cô lập chạy tương tác chuột hoàn toàn độc lập.</span></li><li><strong>Chạy kịch bản kiểm thử</strong><span>Tải ví dụ mẫu, chỉnh sửa JSON và chọn chế độ Theo dõi hoặc Nhanh.</span></li><li><strong>Kiểm tra diễn biến</strong><span>Xem lại kết quả từng bước và tải về bằng chứng kiểm thử từ tab Kết quả.</span></li><li><strong>Tự điều khiển thủ công</strong><span>Bật nút Tương tác bên dưới khung hình để click và cuộn trang. Dùng thanh địa chỉ để chuyển trang.</span></li></ol><div className="guide-note"><ShieldCheck size={17} />Con trỏ ảo chỉ là một lớp phủ trong không gian này. Thao tác trình duyệt không bao giờ di chuyển chuột máy tính của bạn.</div></section></div>}
  </div>;
}

const runStatusText: Record<string, string> = {
  passed: 'Thành công',
  failed: 'Thất bại',
  running: 'Đang chạy',
  queued: 'Đang chờ',
  cancelled: 'Đã hủy'
};

function Stat({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string | number; detail: string }) {
  return <div className="stat-card"><div className="stat-content"><span className="stat-label">{label}</span><div className="stat-value">{value}</div><span className="stat-detail">{detail}</span></div><span className="stat-icon">{icon}</span></div>;
}

function RunIcon({ status }: { status: RunResult['status'] }) {
  return status === 'passed' ? <CheckCircle2 size={18} className="passed-icon" /> : status === 'failed' ? <XCircle size={18} className="failed-icon" /> : status === 'running' ? <LoaderCircle size={18} className="spin running-icon" /> : <Clock3 size={18} className="pending-icon" />;
}

function RunDetails({ run }: { run?: RunResult }) {
  if (!run) return <div className="small-empty results-empty"><div className="empty-result-icon"><CheckCircle2 size={28} /></div><strong>Kiểm thử chuẩn mực luôn lưu lại dấu vết rõ ràng.</strong><span>Hãy chạy một kịch bản để xem kết quả, dòng thời gian từng bước và tệp bằng chứng tại đây.</span></div>;
  const totalDuration = run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : undefined;
  return <div className="run-details"><div className="run-result-heading"><span className={`result-badge ${run.status}`}><RunIcon status={run.status} />{runStatusText[run.status] ?? run.status}</span><span className="run-id">{shortId(run.id)}</span></div><h3>{run.name}</h3><div className="run-metadata"><span><Globe2 size={12} />{run.environment}</span><span>{run.mode === 'watch' ? <Monitor size={12} /> : <Zap size={12} />}{run.mode === 'watch' ? 'theo dõi' : 'nhanh'}</span>{totalDuration !== undefined && <span><Clock3 size={12} />{duration(totalDuration)}</span>}</div>{run.error && <div className="run-error" role="alert">{run.error}</div>}<div className="run-steps-heading"><span className="field-label">DÒNG THỜI GIAN CÁC BƯỚC</span><span>{run.steps.filter(step => step.status === 'passed').length} thành công / {run.steps.length} đã ghi nhận</span></div>{run.steps.length ? <ol className="step-list">{run.steps.map(step => <li key={step.index} className={step.status}><span className="step-marker">{step.status === 'passed' ? <Check size={11} /> : step.status === 'failed' ? <X size={11} /> : <Circle size={9} />}</span><div><strong><span>{String(step.index + 1).padStart(2, '0')}</span>{step.action}</strong>{step.error && <p>{step.error}</p>}</div><span className="step-duration">{duration(step.durationMs)}</span></li>)}</ol> : <div className="steps-pending">{run.status === 'running' || run.status === 'queued' ? <><LoaderCircle size={15} className="spin" />Đang đợi bước đầu tiên…</> : 'Không có bước nào được ghi nhận.'}</div>}<div className="artifacts-heading"><span className="field-label">TỆP BẰNG CHỨNG (ARTIFACTS)</span><span>{run.artifacts.length}</span></div>{run.artifacts.length ? <div className="artifact-list">{run.artifacts.map(artifact => <a href={artifact.url} key={artifact.url} target="_blank" rel="noreferrer"><FileCode2 size={15} /><span>{artifact.name}</span><ArrowDownToLine size={14} /></a>)}</div> : <p className="artifact-empty">{run.status === 'running' ? 'Tệp bằng chứng sẽ xuất hiện khi lượt chạy hoàn tất.' : 'Không có tệp bằng chứng nào cho lượt chạy này.'}</p>}</div>;
}

function EventFeed({ events }: { events: EngineEvent[] }) {
  if (!events.length) return <div className="activity-empty"><SquareTerminal size={22} /><div><strong>Đang lắng nghe sự kiện trình duyệt</strong><span>Các sự kiện phiên làm việc, thao tác và tiến trình thực thi sẽ xuất hiện ở đây.</span></div><span className="terminal-caret" /></div>;
  return <ol className="event-feed" aria-label="Sự kiện động cơ gần đây">{events.map((event, index) => <li key={`${event.sequence}-${event.type}-${index}`}><time>{new Date(event.timestamp).toLocaleTimeString('vi-VN', { hour12: false })}</time><span className={`event-type ${event.type.startsWith('mouse:') ? 'mouse' : event.type.startsWith('run:') || event.type.startsWith('test:') ? 'test' : ''}`}>{event.type}</span><span className="event-detail">{event.type === 'test:step' ? `${String(event.action ?? 'bước')} · ${String(event.status ?? '')}` : event.type === 'run:updated' ? String((event.run as RunResult | undefined)?.status ?? '') : event.pageId ? `trang ${shortId(event.pageId)}` : event.sessionId ? `phiên ${shortId(event.sessionId)}` : event.runId ? `lượt chạy ${shortId(event.runId)}` : 'động cơ'}</span><span className="event-sequence">#{event.sequence}</span></li>)}</ol>;
}
