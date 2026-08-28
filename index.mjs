import { registerRoutes } from './src/routes.mjs';
import { API_CURRENT, API_SUPPORTED, PLUGIN_ID, PLUGIN_NAME, VERSION } from './src/config.mjs';

export const info = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  chineseName: '白鳥数据后端',
  version: VERSION,
  description: 'Zero-dependency, UI-free V1 user-scoped data backend.',
};

export const api = { current: API_CURRENT, supported: API_SUPPORTED };

export function init(router) { return registerRoutes(router); }
export function exit() {}
