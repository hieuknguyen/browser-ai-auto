import { ArrowDown, ArrowUp, ListOrdered, Plus, Trash2 } from 'lucide-react';

export interface DraftJob { id: string; instruction: string }
export const newDraftJob = (instruction = ''): DraftJob => ({ id: crypto.randomUUID(), instruction });

interface Props {
  jobs: DraftJob[];
  onChange: (jobs: DraftJob[]) => void;
  name: string;
  onName: (name: string) => void;
  bulkText: string;
  onBulkText: (text: string) => void;
  onError: (message: string) => void;
}

export function WorkflowComposer({ jobs, onChange, name, onName, bulkText, onBulkText, onError }: Props) {
  const move = (index: number, offset: number) => {
    const next = [...jobs];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };
  const importLines = () => {
    const lines = bulkText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const existing = jobs.filter(job => job.instruction.trim());
    if (!lines.length) return;
    if (existing.length + lines.length > 50) { onError('Danh sách chỉ chứa tối đa 50 công việc. Hãy giảm số dòng trước khi thêm.'); return; }
    if (lines.some(line => line.length < 3 || line.length > 12000)) { onError('Mỗi công việc cần từ 3 đến 12.000 ký tự. Kiểm tra lại các dòng vừa dán.'); return; }
    onChange([...existing, ...lines.map(newDraftJob)]);
    onBulkText('');
  };

  return <div className="workflow-composer">
    <label className="ai-field"><span>Tên danh sách <small>tùy chọn</small></span><input value={name} maxLength={120} onChange={event => onName(event.target.value)} placeholder="Ví dụ: Tìm và tổng hợp thông tin sản phẩm" /></label>
    <div className="workflow-list-heading"><span><ListOrdered size={15} />Thứ tự thực hiện</span><small>{jobs.length} / 50 công việc</small></div>
    <ol className="workflow-draft-list">
      {jobs.map((job, index) => <li key={job.id}>
        <div className="workflow-draft-heading"><label htmlFor={`job-${job.id}`}>Công việc {index + 1}</label><div className="workflow-reorder">
          <button type="button" className="icon-button" disabled={index === 0} aria-label={`Đưa công việc ${index + 1} lên`} title="Đưa lên" onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="icon-button" disabled={index === jobs.length - 1} aria-label={`Đưa công việc ${index + 1} xuống`} title="Đưa xuống" onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
          <button type="button" className="icon-button" disabled={jobs.length === 1} aria-label={`Xóa công việc ${index + 1}`} title="Xóa công việc" onClick={() => onChange(jobs.filter(item => item.id !== job.id))}><Trash2 size={14} /></button>
        </div></div>
        <textarea id={`job-${job.id}`} required minLength={3} maxLength={12000} rows={3} value={job.instruction} onChange={event => onChange(jobs.map(item => item.id === job.id ? { ...item, instruction: event.target.value } : item))} placeholder={index === 0 ? 'Mở trang và tìm thông tin cần thiết…' : 'Dựa trên trang hiện tại, thực hiện công việc tiếp theo…'} />
      </li>)}
    </ol>
    <button type="button" className="button secondary workflow-add" disabled={jobs.length >= 50} onClick={() => onChange([...jobs, newDraftJob()])}><Plus size={14} />Thêm công việc</button>
    <details className="workflow-import"><summary>Dán nhanh nhiều công việc</summary><label className="ai-field"><span>Mỗi dòng là một công việc</span><textarea rows={4} value={bulkText} onChange={event => onBulkText(event.target.value)} placeholder={'Mở trang giới thiệu và đọc nội dung\nTìm thông tin liên hệ\nTổng hợp kết quả bằng tiếng Việt'} /></label><p className="ai-field-help">Các dòng được thêm vào cuối danh sách. Dòng trống được bỏ qua.</p><button type="button" className="button secondary" disabled={!bulkText.trim()} onClick={importLines}><Plus size={14} />Thêm các dòng vào danh sách</button></details>
  </div>;
}
