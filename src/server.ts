import './config/load-env.js';
import { createApp } from './api/app.js';
const port = Number(process.env.PORT || 3210);
const { app } = await createApp({ productionUI: process.argv.includes('--production-ui') });
await app.listen({ host: process.env.ENGINE_HOST || '127.0.0.1', port });
console.log(`\nPhòng thí nghiệm trình duyệt đã sẵn sàng: http://localhost:${port}\nNhấn Ctrl+C để dừng máy chủ.\n`);
if (process.argv.includes('--demo')) {
  const response = await app.inject({ method: 'POST', url: '/api/demo', headers: { host: `localhost:${port}` } });
  if (response.statusCode >= 400) console.error('Không thể khởi chạy bản thử nghiệm:', response.body);
}
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
