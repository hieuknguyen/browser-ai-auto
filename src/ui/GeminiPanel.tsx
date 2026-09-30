import { useEffect, useState } from 'react';
import { ArrowUpRight, Camera, Check, CheckCircle2, Chrome, Clock3, Eye, EyeOff, Globe2, KeyRound, ListOrdered, LoaderCircle, LockKeyhole, Play, Settings2, Sparkles, Square, Trash2, X, XCircle } from 'lucide-react';
import type { AISettings, AITask, AIWorkflow, SessionInfo } from '../shared/types';
import { api } from './events';
import { newDraftJob, WorkflowComposer } from './WorkflowComposer';
import { workflowActive, workflowLabels, WorkflowProgress } from './WorkflowProgress';

interface Props {
  settings: AISettings;
  tasks: AITask[];
  workflows: AIWorkflow[];
  sessions: SessionInfo[];
  reservedSessions: Set<string>;
  connected: boolean;
  onSettings: (settings: AISettings) => void;
  onTask: (task: AITask) => void;
  onWorkflow: (workflow: AIWorkflow) => void;
  onError: (message: string) => void;
  onViewSession: (sessionId: string) => void;
}

const statusLabels: Record<AITask['status'], string> = { queued: 'Đang chờ', running: 'Đang thực hiện', completed: 'Hoàn tất', failed: 'Thất bại', cancelled: 'Đã dừng' };
const isActive = (task: AITask) => task.status === 'queued' || task.status === 'running';

export function GeminiPanel({ settings, tasks, workflows, sessions, reservedSessions, connected, onSettings, onTask, onWorkflow, onError, onViewSession }: Props) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('vector_ai_key') || '');
  const [showKey, setShowKey] = useState(false);
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('vector_ai_url') || settings.apiUrl || '');
  const [model, setModel] = useState(() => localStorage.getItem('vector_ai_model') || settings.model || 'gemini-2.5-flash');
  const [instruction, setInstruction] = useState('');
  const [composeMode, setComposeMode] = useState<'single' | 'list'>('list');
  const [jobs, setJobs] = useState(() => [newDraftJob(), newDraftJob()]);
  const [workflowName, setWorkflowName] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [continueOnError, setContinueOnError] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>();
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [loadingTaskId, setLoadingTaskId] = useState<string>();
  const [startUrl, setStartUrl] = useState('https://example.com');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [maxSteps, setMaxSteps] = useState(20);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [stopping, setStopping] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [followUpText, setFollowUpText] = useState('');
  const [targetSessionId, setTargetSessionId] = useState<string>('new');
  const selectedWorkflow = workflows.find(workflow => workflow.id === selectedWorkflowId) ?? workflows[0];
  const workflowItem = selectedWorkflow?.items.find(item => item.id === selectedItemId)
    ?? selectedWorkflow?.items.find(item => item.status === 'running')
    ?? selectedWorkflow?.items.find(item => item.status === 'failed' || item.status === 'cancelled')
    ?? selectedWorkflow?.items.find(item => item.status === 'pending')
    ?? selectedWorkflow?.items.at(-1);
  const selectedTask = composeMode === 'list'
    ? tasks.find(task => task.id === workflowItem?.taskId)
    : tasks.find(task => task.id === selectedId) ?? tasks[0];
  const sessionAvailable = sessions.some(session => session.id === selectedTask?.sessionId);
  const selectedSessionReserved = !!selectedTask?.sessionId && reservedSessions.has(selectedTask.sessionId);
  const targetReserved = targetSessionId !== 'new' && reservedSessions.has(targetSessionId);
  const activeWorkflow = workflows.find(workflowActive);
  const listBlocked = composeMode === 'list' && !!activeWorkflow;
  const selectedTaskExists = !!selectedTask;

  useEffect(() => {
    if (targetSessionId !== 'new' && !sessions.some(session => session.id === targetSessionId)) setTargetSessionId('new');
  }, [sessions, targetSessionId]);

  useEffect(() => {
    if (composeMode !== 'list' || !workflowItem?.taskId || selectedTaskExists) return;
    let cancelled = false;
    const taskId = workflowItem.taskId;
    setLoadingTaskId(taskId);
    void api<AITask>(`/ai/tasks/${taskId}`).then(task => { if (!cancelled) onTask(task); })
      .catch(error => { if (!cancelled) onError(error instanceof Error ? error.message : 'Không tải được thao tác của công việc.'); })
      .finally(() => { if (!cancelled) setLoadingTaskId(undefined); });
    return () => { cancelled = true; };
  }, [composeMode, workflowItem?.taskId, selectedTaskExists, onTask, onError]);

  useEffect(() => {
    if (settings.model && !localStorage.getItem('vector_ai_model')) {
      setModel(settings.model);
    }
    if (settings.apiUrl !== undefined && !localStorage.getItem('vector_ai_url')) {
      setApiUrl(settings.apiUrl);
    }
  }, [settings.model, settings.apiUrl]);

  const perform = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    try { await action(); }
    catch (error) { onError(error instanceof Error ? error.message : 'Không thể hoàn thành yêu cầu.'); }
    finally { setBusy(null); }
  };

  const saveSettings = () => perform('settings', async () => {
    const trimmedKey = apiKey.trim();
    const trimmedUrl = apiUrl.trim();
    const trimmedModel = model.trim();

    const result = await api<AISettings>('/ai/settings', {
      ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      apiUrl: trimmedUrl,
      model: trimmedModel,
    }, 'PUT');

    if (trimmedKey) localStorage.setItem('vector_ai_key', trimmedKey);
    if (trimmedUrl) localStorage.setItem('vector_ai_url', trimmedUrl);
    if (trimmedModel) localStorage.setItem('vector_ai_model', trimmedModel);

    onSettings(result);
    setSaved(true);
  });

  const clearSettings = () => perform('clear', async () => {
    await api('/ai/settings', undefined, 'DELETE');
    localStorage.removeItem('vector_ai_key');
    setApiKey('');
    onSettings(await api<AISettings>('/ai/settings'));
    setSaved(false);
  });

  const startTask = () => perform('start', async () => {
    const isNew = targetSessionId === 'new';
    let urlString = isNew ? startUrl.trim() : '';
    if (isNew) {
      const url = new URL(urlString);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL bắt đầu cần dùng http:// hoặc https://.');
      urlString = url.href;
    }
    if (targetReserved) throw new Error('Chrome này đang thực hiện công việc. Hãy chờ hoàn tất hoặc chọn cửa sổ mới.');
    if (listBlocked) throw new Error('Một danh sách đang chạy. Hãy chờ hoàn tất hoặc dừng danh sách đó trước.');
    const shared = {
      startUrl: urlString,
      maxSteps,
      ...(targetSessionId !== 'new' ? { sessionId: targetSessionId } : {}),
      ...(allowedDomains.trim() ? { allowedDomains: [...new Set(allowedDomains.split(',').map(domain => domain.trim()).filter(Boolean))] } : {}),
    };
    if (composeMode === 'list') {
      const workflow = await api<AIWorkflow>('/ai/workflows', { ...shared, instructions: jobs.map(job => job.instruction.trim()), continueOnError, ...(workflowName.trim() ? { name: workflowName.trim() } : {}) });
      onWorkflow(workflow); setSelectedWorkflowId(workflow.id); setSelectedItemId(undefined);
    } else {
      const task = await api<AITask>('/ai/tasks', { ...shared, instruction: instruction.trim() });
      onTask(task); setSelectedId(task.id);
    }
  });

  const submitFollowUp = () => perform('followup', async () => {
    if (!selectedTask?.sessionId || followUpText.trim().length < 3 || selectedSessionReserved) return;
    const task = await api<AITask>('/ai/tasks', {
      instruction: followUpText.trim(),
      startUrl: '',
      sessionId: selectedTask.sessionId,
      maxSteps: 20,
    });
    onTask(task);
    setSelectedId(task.id);
    setComposeMode('single');
    setFollowUpText('');
  });

  const stopTask = async (task: AITask) => {
    setStopping(task.id);
    try {
      await api(`/ai/tasks/${task.id}`, undefined, 'DELETE');
      // The event stream supplies the final state; refresh also works after a reconnect.
      const result = await api<{ tasks: AITask[] }>('/ai/tasks');
      const updated = result.tasks.find(item => item.id === task.id);
      if (updated) onTask(updated);
    } catch (error) { onError(error instanceof Error ? error.message : 'Không thể dừng tác vụ.'); }
    finally { setStopping(undefined); }
  };

  const stopWorkflow = async (workflow: AIWorkflow) => {
    setStopping(workflow.id);
    try {
      await api(`/ai/workflows/${workflow.id}`, undefined, 'DELETE');
      const result = await api<{ workflows: AIWorkflow[] }>('/ai/workflows');
      const updated = result.workflows.find(item => item.id === workflow.id);
      if (updated) onWorkflow(updated);
    } catch (error) { onError(error instanceof Error ? error.message : 'Không thể dừng danh sách.'); }
    finally { setStopping(undefined); }
  };
  const resumeWorkflow = (workflow: AIWorkflow) => perform('resume', async () => {
    const updated = await api<AIWorkflow>(`/ai/workflows/${workflow.id}/resume`, {});
    onWorkflow(updated); setSelectedItemId(undefined);
  });

  const focusChrome = () => perform('focus', async () => { if (selectedTask?.sessionId) await api(`/sessions/${selectedTask.sessionId}/focus`, {}); });
  const takeScreenshot = () => perform('screenshot', async () => {
    if (!selectedTask?.sessionId) return;
    setCapturing(true);
    try {
      const res = await api<{ data: string; url: string }>(`/sessions/${selectedTask.sessionId}/screenshot`, {});
      setPreviewImage(`data:image/jpeg;base64,${res.data}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Không thể chụp màn hình.');
    } finally {
      setCapturing(false);
    }
  });
  const disabled = !connected || !!busy;
  const validInstructions = composeMode === 'list'
    ? jobs.length >= 1 && jobs.length <= 50 && jobs.every(job => job.instruction.trim().length >= 3 && job.instruction.trim().length <= 12000)
    : instruction.trim().length >= 3 && instruction.trim().length <= 12000;

  return <div className="gemini-layout">
    <div className="gemini-compose">
      <section className="gemini-card settings-card" aria-labelledby="gemini-settings-title">
        <div className="section-heading"><div className="section-title"><KeyRound size={17} /><h2 id="gemini-settings-title">Cấu hình AI</h2></div><span className={`ai-key-status ${settings.configured ? 'ready' : ''}`}><span />{settings.configured ? 'Đã lưu cấu hình' : 'Chưa kết nối'}</span></div>
        <form className="gemini-form" onSubmit={event => { event.preventDefault(); void saveSettings(); }}>
          <label className="ai-field"><span>Đường dẫn API (API URL)</span><input value={apiUrl} onChange={event => { setApiUrl(event.target.value); setSaved(false); }} placeholder="http://localhost:5678/v1/chat" spellCheck={false} /></label>
          <label className="ai-field">
            <span>API Key {settings.configured && <small style={{ color: '#769750' }}>(Đã lưu cấu hình)</small>}</span>
            <div className="ai-key-input">
              <KeyRound size={15} style={{ flexShrink: 0, opacity: 0.65 }} />
              <input
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={event => { setApiKey(event.target.value); setSaved(false); }}
                placeholder={settings.configured ? (settings.keyPreview ? `Đã lưu key (${settings.keyPreview})` : 'Đã cấu hình API key') : 'Nhập API key của bạn'}
                aria-describedby="key-description"
              />
              {apiKey && (
                <button
                  type="button"
                  onClick={() => setShowKey(v => !v)}
                  title={showKey ? 'Ẩn API Key' : 'Hiện API Key'}
                  aria-label={showKey ? 'Ẩn API Key' : 'Hiện API Key'}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              )}
            </div>
          </label>
          <label className="ai-field"><span>Model</span><input required value={model} onChange={event => { setModel(event.target.value); setSaved(false); }} placeholder="gemini-2.5-flash" spellCheck={false} /></label>
          <p className="ai-field-help" id="key-description"><LockKeyhole size={12} />Hỗ trợ proxy OpenAI-compatible và Google Gemini. Khi bấm &quot;Lưu cấu hình&quot;, dữ liệu sẽ được lưu vĩnh viễn vào file .env và bộ nhớ trình duyệt.</p>
          <div className="ai-settings-actions">
            <button className="button secondary" disabled={disabled || !model.trim() || (!settings.configured && !apiKey.trim())} type="submit">
              {busy === 'settings' ? <LoaderCircle size={14} className="spin" /> : saved ? <Check size={14} /> : <KeyRound size={14} />}
              {saved ? 'Đã lưu cấu hình vĩnh viễn' : 'Lưu cấu hình'}
            </button>
            {settings.configured && (
              <button className="text-button" type="button" disabled={disabled} onClick={() => void clearSettings()}>
                <Trash2 size={13} />
                Xóa key
              </button>
            )}
          </div>
          <div className="ai-key-source" role="status">
            {saved ? (
              <strong style={{ color: '#4d7c0f' }}>✓ Cấu hình đã được lưu vĩnh viễn vào file .env và bộ nhớ trình duyệt.</strong>
            ) : settings.configured ? (
              <span>Đang dùng cấu hình hoạt động{settings.keyPreview ? ` (Key: ${settings.keyPreview})` : ''}. Dữ liệu được lưu vĩnh viễn vào .env.</span>
            ) : (
              <span>Nhập API URL và API key để bắt đầu điều khiển Chrome.</span>
            )}
          </div>
        </form>
      </section>

      <section className="gemini-card task-compose" aria-labelledby="gemini-task-title">
        <div className="section-heading"><div className="section-title"><Sparkles size={17} /><h2 id="gemini-task-title">Bạn muốn Chrome làm gì?</h2></div><span className="ai-provider-tag">GEMINI</span></div>
        <form className="gemini-form" onSubmit={event => { event.preventDefault(); void startTask(); }}>
          <div className="workflow-mode-toggle" aria-label="Cách giao công việc">
            <button type="button" aria-pressed={composeMode === 'single'} className={composeMode === 'single' ? 'active' : ''} onClick={() => setComposeMode('single')}><Sparkles size={14} />Một công việc</button>
            <button type="button" aria-pressed={composeMode === 'list'} className={composeMode === 'list' ? 'active' : ''} onClick={() => setComposeMode('list')}><ListOrdered size={15} />Danh sách công việc</button>
          </div>
          {composeMode === 'list' && <p className="workflow-sequence-note"><ListOrdered size={16} /><span>AI làm từ trên xuống: xong công việc 1 mới chuyển sang công việc 2. Giữ nguyên cùng cửa sổ Chrome và trang hiện tại giữa các công việc.</span></p>}
          {sessions.length > 0 && (
            <label className="ai-field">
              <span>Cửa sổ Chrome thực thi</span>
              <select value={targetSessionId} onChange={event => setTargetSessionId(event.target.value)} style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px', background: '#fff' }}>
                <option value="new">Mở cửa sổ Chrome mới</option>
                {sessions.map((s, idx) => (
                  <option key={s.id} value={s.id} disabled={reservedSessions.has(s.id)}>
                    Tiếp tục trên Trình duyệt {String(idx + 1).padStart(2, '0')} ({sessionHost(s)}){reservedSessions.has(s.id) ? ' · Đang thực hiện công việc' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {composeMode === 'list' ? <WorkflowComposer jobs={jobs} onChange={setJobs} name={workflowName} onName={setWorkflowName} bulkText={bulkText} onBulkText={setBulkText} onError={onError} /> : <label className="ai-field"><span>Yêu cầu của bạn</span><textarea required minLength={3} maxLength={12000} rows={5} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="Ví dụ: Đọc nội dung trên trang và tóm tắt bằng tiếng Việt. Nếu có trang About, hãy mở và tìm thông tin giới thiệu." /></label>}
          {targetSessionId === 'new' && (
            <label className="ai-field"><span>URL bắt đầu</span><div className="ai-url-input"><Globe2 size={15} /><input type="url" required value={startUrl} onChange={event => setStartUrl(event.target.value)} placeholder="https://example.com" spellCheck={false} /></div></label>
          )}
          <button className="text-button ai-advanced-toggle" type="button" aria-expanded={advanced} aria-controls="ai-advanced-options" onClick={() => setAdvanced(value => !value)}><Settings2 size={14} />{advanced ? 'Ẩn tùy chọn' : 'Tùy chọn tác vụ'}</button>
          {advanced && <div className="ai-advanced" id="ai-advanced-options"><label className="ai-field"><span>Tên miền được phép <small>tùy chọn</small></span><input value={allowedDomains} onChange={event => setAllowedDomains(event.target.value)} placeholder="example.com, docs.example.com" /><span className="ai-field-help">Để trống để dùng tên miền của URL bắt đầu. Ngăn cách các tên miền bằng dấu phẩy.</span></label><label className="ai-field"><span>Số bước tối đa {composeMode === 'list' ? 'cho mỗi công việc' : ''}</span><input type="number" required min={1} max={50} value={maxSteps} onChange={event => setMaxSteps(Number(event.target.value))} /><span className="ai-field-help">Từ 1 đến 50 thao tác AI cho mỗi công việc.</span></label></div>}
          {composeMode === 'list' && <label className="workflow-error-option"><input type="checkbox" checked={continueOnError} onChange={event => setContinueOnError(event.target.checked)} /><span><strong>Tiếp tục công việc sau nếu có lỗi</strong><small>{continueOnError ? 'Công việc lỗi vẫn được ghi nhận; AI tiếp tục theo thứ tự còn lại.' : 'Mặc định dừng danh sách khi gặp lỗi để bạn kiểm tra và chạy tiếp.'}</small></span></label>}
          <div className="ai-data-notice"><Sparkles size={15} /><p>Khi chạy, yêu cầu và ảnh chụp/nội dung trang được gửi đến AI để quyết định từng thao tác.</p></div>
          {targetReserved && <p className="ai-field-help" role="status">Chrome đã chọn đang bận. Chọn cửa sổ mới hoặc chờ công việc hiện tại hoàn tất.</p>}
          {listBlocked && <div className="workflow-running-notice" role="status"><p className="ai-field-help">Đã có một danh sách đang chạy. Bạn vẫn có thể soạn danh sách tiếp theo và chạy sau khi lượt hiện tại hoàn tất.</p><button type="button" className="text-button" onClick={() => { setSelectedWorkflowId(activeWorkflow.id); setSelectedItemId(undefined); }}>Xem danh sách đang chạy<ArrowUpRight size={12} /></button></div>}
          <button className="button primary ai-start-button" type="submit" disabled={disabled || targetReserved || listBlocked || !settings.configured || !validInstructions || (targetSessionId === 'new' && !startUrl.trim()) || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50}>
            {busy === 'start' ? <LoaderCircle size={15} className="spin" /> : <Play size={14} fill="currentColor" />}
            {composeMode === 'list' ? `Chạy lần lượt ${jobs.length} công việc` : targetSessionId !== 'new' ? 'Tiếp tục trên Chrome hiện tại' : 'Mở Chrome & thực hiện'}
          </button>
          <p className="ai-launch-hint"><Chrome size={13} />Cửa sổ Google Chrome thật sẽ tự động bật lên màn hình máy tính của bạn. Bạn theo dõi AI thao tác trực tiếp trên Chrome.</p>
        </form>
      </section>
    </div>

    <section className="gemini-card ai-progress-card" aria-labelledby="ai-progress-title">
      <div className="section-heading"><div className="section-title">{composeMode === 'list' ? <ListOrdered size={17} /> : <ActivityIcon task={selectedTask} />}<h2 id="ai-progress-title">{composeMode === 'list' ? 'Tiến trình danh sách' : 'Tiến trình thực hiện'}</h2></div><span className="count-pill">{composeMode === 'list' ? workflows.length : tasks.length}</span></div>
      {composeMode === 'list' && workflows.length > 0 && <label className="ai-task-selector"><span>Danh sách</span><select value={selectedWorkflow?.id ?? ''} onChange={event => { setSelectedWorkflowId(event.target.value); setSelectedItemId(undefined); }}>{workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflowLabels[workflow.status]} · {workflow.name || workflow.items[0]?.instruction.slice(0, 45)}</option>)}</select></label>}
      {composeMode === 'list' && selectedWorkflow && <WorkflowProgress workflow={selectedWorkflow} selectedItemId={workflowItem?.id} onSelectItem={item => setSelectedItemId(item.id)} onStop={() => void stopWorkflow(selectedWorkflow)} onResume={() => void resumeWorkflow(selectedWorkflow)} onViewSession={onViewSession} disabled={disabled} stopping={stopping === selectedWorkflow.id} resuming={busy === 'resume'} sessionAvailable={sessions.some(session => session.id === selectedWorkflow.sessionId)} sessionReserved={!!activeWorkflow || (!!selectedWorkflow.sessionId && reservedSessions.has(selectedWorkflow.sessionId))} />}
      {composeMode === 'single' && tasks.length > 0 && <label className="ai-task-selector"><span>Tác vụ</span><select value={selectedTask?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>{tasks.map(task => <option key={task.id} value={task.id}>{statusLabels[task.status]} · {task.instruction.slice(0, 65)}</option>)}</select></label>}
      {selectedTask ? <div className="ai-task-details">
        {composeMode === 'list' && workflowItem && <div className="workflow-detail-label">THAO TÁC CÔNG VIỆC {workflowItem.index + 1}</div>}
        <div className="ai-task-heading"><span className={`result-badge ${selectedTask.status === 'completed' ? 'passed' : selectedTask.status}`}>{statusLabels[selectedTask.status]}</span><span className="run-id">{selectedTask.id.slice(0, 8)}</span></div>
        <h3>{selectedTask.instruction}</h3><p className="ai-task-url"><Globe2 size={13} />{selectedTask.startUrl}</p>
        <div className="ai-task-actions">
          {selectedTask.sessionId && sessionAvailable && <>
            <button className="button secondary" disabled={disabled} onClick={() => void focusChrome()}><Chrome size={14} />Đưa Chrome lên trước</button>
            <button className="button secondary" disabled={disabled || capturing} onClick={() => void takeScreenshot()}>
              {capturing ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}
              Chụp màn hình
            </button>
            <button className="text-button" onClick={() => onViewSession(selectedTask.sessionId!)}>Xem khung ảnh dashboard<ArrowUpRight size={13} /></button>
          </>}
          {isActive(selectedTask) && composeMode === 'single' && <button className="button ai-stop-button" disabled={!connected || stopping === selectedTask.id} onClick={() => void stopTask(selectedTask)}>{stopping === selectedTask.id ? <LoaderCircle size={13} className="spin" /> : <Square size={12} fill="currentColor" />}Dừng tác vụ</button>}
        </div>
        <div className="ai-progress-label"><span className="field-label">CÁC BƯỚC THỰC HIỆN</span><span>{selectedTask.steps.length} bước</span></div>
        {selectedTask.steps.length ? <ol className="ai-step-list">{selectedTask.steps.map((step, index) => <li key={`${step.index}-${index}`} className={step.status}><span className="ai-step-marker">{step.status === 'failed' ? <XCircle size={15} /> : step.status === 'running' ? <LoaderCircle size={15} className="spin" /> : <Check size={13} />}</span><div><div className="ai-step-heading"><strong>{String(index + 1).padStart(2, '0')}</strong><code>{step.action}</code></div><p>{step.summary || 'Đang thực hiện thao tác…'}</p>{step.error && <p className="ai-step-error">{step.error}</p>}{step.screenshot && <div style={{ marginTop: '6px' }}><img src={step.screenshot} alt={`Ảnh bước ${index + 1}`} onClick={() => setPreviewImage(step.screenshot!)} title="Bấm để xem ảnh phóng to" style={{ maxHeight: '90px', borderRadius: '4px', border: '1px solid #cbd5e1', cursor: 'pointer', display: 'block' }} /></div>}</div></li>)}</ol> : <div className="ai-awaiting">{isActive(selectedTask) ? <><LoaderCircle size={19} className="spin" /><p>Đang mở Chrome và chuẩn bị bước đầu tiên…</p></> : <p>Chưa có bước nào được ghi nhận.</p>}</div>}
        {selectedTask.artifacts && selectedTask.artifacts.length > 0 && (
          <div style={{ marginTop: '12px', padding: '10px 14px', background: 'rgba(59,130,246,0.06)', borderRadius: '6px', border: '1px solid rgba(59,130,246,0.15)' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#1d4ed8', letterSpacing: '0.05em' }}>ẢNH CHỤP ĐÃ LƯU</span>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
              {selectedTask.artifacts.map(a => (
                <a key={a.url} href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: '#2563eb', display: 'flex', alignItems: 'center', gap: '4px', textDecoration: 'none', background: '#fff', padding: '4px 8px', borderRadius: '4px', border: '1px solid #cbd5e1' }}>
                  <Camera size={12} /> {a.name}
                </a>
              ))}
            </div>
          </div>
        )}
        {selectedTask.error && <div className="run-error" role="alert">{selectedTask.error}</div>}
        {selectedTask.answer && <div className="ai-answer"><span><Sparkles size={15} />Kết quả từ AI</span><p>{selectedTask.answer}</p></div>}
        {selectedTask.status === 'cancelled' && <p className="ai-field-help">Tác vụ đã dừng. Chrome vẫn mở để bạn tiếp tục xem trang.</p>}
        {selectedTask && !isActive(selectedTask) && selectedTask.sessionId && sessionAvailable && (
          <div className="ai-followup-card" style={{ marginTop: '16px', padding: '14px 16px', background: 'rgba(34, 197, 94, 0.05)', borderRadius: '8px', border: '1px solid rgba(34, 197, 94, 0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#15803d', fontWeight: 600, fontSize: '13px' }}>
                <Sparkles size={16} />
                <span>Ra thêm yêu cầu tiếp theo cho trình duyệt này</span>
              </div>
              <span style={{ fontSize: '11px', background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>Giữ nguyên trang hiện tại</span>
            </div>
            <form onSubmit={event => { event.preventDefault(); void submitFollowUp(); }} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <textarea
                rows={3}
                minLength={3}
                maxLength={12000}
                disabled={selectedSessionReserved}
                value={followUpText}
                onChange={e => setFollowUpText(e.target.value)}
                placeholder="Nhập yêu cầu tiếp theo... (Ví dụ: Bấm thích video này, cuộn xuống đọc bình luận, hoặc mở tiếp bài hát khác...)"
                style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="submit"
                  className="button primary"
                  disabled={disabled || selectedSessionReserved || followUpText.trim().length < 3}
                  style={{ background: '#16a34a', borderColor: '#16a34a', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  {busy === 'followup' ? <LoaderCircle size={14} className="spin" /> : <Play size={14} fill="currentColor" />}
                  Thực hiện tiếp tục
                </button>
              </div>
              {selectedSessionReserved && <p className="ai-field-help">Chrome đang được giữ cho danh sách hoặc tác vụ đang chạy. Bạn có thể gửi yêu cầu mới khi lượt chạy hoàn tất hoặc đã dừng.</p>}
            </form>
          </div>
        )}
      </div> : composeMode === 'list' && selectedWorkflow ? <div className="ai-awaiting">{loadingTaskId === workflowItem?.taskId && loadingTaskId ? <><LoaderCircle size={16} className="spin" />Đang tải thao tác công việc…</> : <p>{workflowItem?.taskId ? 'Chưa tải được chi tiết thao tác.' : 'Chọn công việc đã chạy để xem từng thao tác và ảnh chụp.'}</p>}</div> : <div className="ai-progress-empty"><div className="ai-empty-orbit"><Chrome size={32} /><span>{composeMode === 'list' ? <ListOrdered size={17} /> : <Sparkles size={17} />}</span></div><span className="empty-kicker">TỪ YÊU CẦU ĐẾN THAO TÁC</span><h3>{composeMode === 'list' ? <>Giao việc một lần.<br />Thực hiện lần lượt.</> : <>Gemini điều khiển.<br />Bạn theo dõi.</>}</h3><p>{composeMode === 'list' ? 'Thêm công việc theo thứ tự, kết nối API và chạy danh sách. Bạn theo dõi kết quả từng công việc tại đây.' : 'Kết nối API key, mô tả công việc và bắt đầu. Mỗi thao tác trên Chrome sẽ xuất hiện tại đây.'}</p><div className="ai-empty-flow"><span>{composeMode === 'list' ? 'Danh sách' : 'Yêu cầu'}</span><ArrowUpRight size={13} /><span>Gemini</span><ArrowUpRight size={13} /><span>Chrome</span></div></div>}
    </section>
    {previewImage && (
      <div className="modal-backdrop" onClick={() => setPreviewImage(null)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, background: 'rgba(0,0,0,0.6)' }}>
        <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '8px', padding: '16px', maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto', position: 'relative', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <strong style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}><Camera size={16} />Ảnh chụp màn hình Chrome</strong>
            <button type="button" onClick={() => setPreviewImage(null)} className="icon-button" aria-label="Đóng"><X size={18} /></button>
          </div>
          <img src={previewImage} alt="Ảnh chụp màn hình" style={{ maxWidth: '100%', maxHeight: '75vh', display: 'block', borderRadius: '4px' }} />
        </div>
      </div>
    )}
  </div>;
}

function sessionHost(session: SessionInfo) {
  try { return new URL(session.pages[0]?.url ?? '').hostname || session.id.slice(0, 8); }
  catch { return session.id.slice(0, 8); }
}

function ActivityIcon({ task }: { task?: AITask }) {
  if (task && isActive(task)) return <LoaderCircle size={17} className="spin" />;
  if (task?.status === 'completed') return <CheckCircle2 size={17} />;
  return <Clock3 size={17} />;
}
