import { ServerPluginError } from './server-plugins.mjs';

export function registerAdminPluginRoutes(router, { service }) {
  const route = action => async (request, response) => {
    if (request?.user?.profile?.admin !== true) {
      response.status(403).json({ error: 'admin_required', message: '请使用酒馆管理员账号登录后管理服务端插件。' });
      return;
    }
    try {
      const result = action === 'list' ? { plugins: await service.list() } : await service.update(request.body?.directory);
      response.status(200).json({ ok: true, ...result });
    } catch (error) {
      const known = error instanceof ServerPluginError;
      response.status(known ? error.statusCode : 500).json({
        error: known ? error.code : 'plugin_operation_failed',
        message: known ? error.message : '插件管理未完成，请检查服务器的 Git 与插件目录权限后重试。',
      });
    }
  };
  router.post('/v1/admin/plugins/list', route('list'));
  router.post('/v1/admin/plugins/update', route('update'));
  return router;
}
