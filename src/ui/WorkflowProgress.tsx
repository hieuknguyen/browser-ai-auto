import { Check, ChevronRight, Chrome, Circle, ListOrdered, LoaderCircle, RotateCcw, Square, X } from 'lucide-react';
import type { AIWorkflow, AIWorkflowItem } from '../shared/types';

export const workflowActive = (workflow: AIWorkflow) => workflow.status === 'queued' || workflow.status === 'running';
export const workflowLabels: Record<AIWorkflow['status'], string> = {
  queued: 'Đang chờ', running: 'Đang chạy lần lượt', completed: 'Hoàn tất',
  completed_with_errors: 'Kết thúc, có công việc lỗi', failed: 'Đã dừng do lỗi', cancelled: 'Đã dừng',
};
const itemLabels: Record<AIWorkflowItem['status'], string> = {
  pending: 'Đang chờ', running: 'Đang thực hiện', completed: 'Hoàn tất', failed: 'Lỗi', cancelled: 'Đã dừng', skipped: 'Chưa thực hiện',
};

interface Props {
  workflow: AIWorkflow;
  selectedItemId?: string;
  onSelectItem: (item: AIWorkflowItem) => void;
  onStop: () => void;
  onResume: () => void;
  onViewSession: (id: string) => void;
  disabled: boolean;
  stopping: boolean;
  resuming: boolean;
  sessionAvailable: boolean;
  sessionReserved: boolean;
}

export function WorkflowProgress({ workflow, selectedItemId, onSelectItem, onStop, onResume, onViewSession, disabled, stopping, resuming, sessionAvailable, sessionReserved }: Props) {
  const completed = workflow.items.filter(item => item.status === 'completed').length;
  const failed = workflow.items.filter(item => item.status === 'failed').length;
  const remaining = workflow.items.filter(item => item.status !== 'completed' && item.status !== 'failed').length;
  const active = workflowActive(workflow);
  const resumable = !active && workflow.status !== 'completed' && completed < workflow.items.length;
  return <div className="workflow-progress">
    <div className="ai-task-heading"><span className={`result-badge ${workflow.status === 'completed' ? 'passed' : workflow.status}`}>{workflowLabels[workflow.status]}</span><span className="run-id">{workflow.id.slice(0, 8)}</span></div>
    <h3><ListOrdered size={18} />{workflow.name || 'Danh sách công việc'}</h3>
    <div className="workflow-progress-count" aria-live="polite"><strong>{completed} / {workflow.items.length} hoàn tất</strong><span>{failed > 0 && `${failed} lỗi · `}{active && workflow.activeIndex !== undefined ? `Đang xử lý công việc ${workflow.activeIndex + 1}` : remaining > 0 ? `${remaining} chưa hoàn tất` : failed ? 'Cần kiểm tra kết quả lỗi' : 'Đã thực hiện toàn bộ danh sách'}</span></div>
    <progress className="workflow-progress-bar" value={completed} max={workflow.items.length} aria-label="Số công việc hoàn tất" />
    <div className="workflow-actions">
      {workflow.sessionId && sessionAvailable && <button type="button" className="text-button" onClick={() => onViewSession(workflow.sessionId!)}><Chrome size={14} />Xem trình duyệt</button>}
      {active && <button type="button" className="button ai-stop-button" disabled={disabled || stopping} onClick={onStop}>{stopping ? <LoaderCircle size={13} className="spin" /> : <Square size={12} fill="currentColor" />}Dừng danh sách</button>}
      {resumable && <button type="button" className="button secondary" disabled={disabled || resuming || sessionReserved} onClick={onResume}>{resuming ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={14} />}Tiếp tục phần chưa hoàn tất</button>}
    </div>
    {resumable && <p className="ai-field-help">Chạy lại từ công việc chưa hoàn tất đầu tiên. Các công việc đã hoàn tất được giữ nguyên.{sessionReserved ? ' Chờ danh sách đang chạy hoặc tác vụ đang dùng Chrome hoàn tất trước khi tiếp tục.' : ''}</p>}
    {workflow.error && <div className="run-error" role="alert">{workflow.error}</div>}
    <ol className="workflow-result-list">
      {workflow.items.map((item, index) => <li key={item.id} className={`${item.status} ${selectedItemId === item.id ? 'selected' : ''}`} aria-current={item.status === 'running' ? 'step' : undefined}>
        <button type="button" className="workflow-item-heading" onClick={() => onSelectItem(item)} aria-expanded={selectedItemId === item.id}>
          <span className="workflow-item-number">{String(index + 1).padStart(2, '0')}</span><span className="workflow-item-title">{item.instruction}</span><ChevronRight size={14} />
        </button>
        <div className="workflow-item-body"><span className={`workflow-item-status ${item.status}`}>{item.status === 'running' ? <LoaderCircle size={12} className="spin" /> : item.status === 'completed' ? <Check size={12} /> : item.status === 'failed' ? <X size={12} /> : <Circle size={10} />}{itemLabels[item.status]}</span>
          {item.error && <p className="workflow-item-error">{item.error}</p>}
          {item.answer && <details className="workflow-item-answer"><summary>Kết quả công việc {index + 1}</summary><p>{item.answer}</p></details>}
          {item.taskId && <button type="button" className="text-button" onClick={() => onSelectItem(item)}>{selectedItemId === item.id ? 'Đang xem thao tác bên dưới' : 'Xem thao tác & ảnh chụp'}<ChevronRight size={12} /></button>}
        </div>
      </li>)}
    </ol>
  </div>;
}
