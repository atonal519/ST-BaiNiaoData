import { randomUUID } from 'node:crypto';

const baseUrl = (process.argv[2] ?? '').replace(/\/+$/u, '');
const pluginBase = `${baseUrl}/api/plugins/st-bainiaodata`;
if (!baseUrl) { console.error('用法：node scripts/live-smoke.mjs <宿主基址>'); process.exitCode = 2; }
else {
  console.log('这是仅供获得额外授权后运行的在线 smoke；本批离线验收不会调用它。');
  const root = `smoke-${randomUUID()}`; const request = async (path, options = {}) => { const response = await fetch(`${pluginBase}${path}`, { ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } }); return { response, body: await response.json().catch(() => ({})) }; };
  try { const health = await request('/v1/health'); if (!health.response.ok || health.body.plugin?.id !== 'st-bainiaodata') throw new Error('health 合同不符合预期'); console.log(`health 成功（namespace=${root}）；未执行写入 smoke。`); } catch { console.error('live smoke 失败'); process.exitCode = 1; }
}
