# ST-bainiaodata

白鳥数据后端（Bainiao Data）正式无 UI V1 骨架，程序版本 `0.1.0`，API 当前版本 `1`。

安装前提是宿主提供兼容 SillyTavern 插件路由注册接口与 `request.user.directories.root`。本插件无 UI、零第三方运行时依赖；宿主基址为 `/api/plugins/st-bainiaodata`，内部路由统一使用 `/v1`。

数据只写入用户根目录下的相对布局：`.st-bainiaodata/storage-v1/records/...` 与 `.st-bainiaodata/storage-v1/system-trash/...`，不读取或迁移原型数据；namespace 只是逻辑隔离，不是安全权限边界。

已支持记录 CRUD、列表、revision 乐观并发、单文件临时写入后原子替换、回收站与恢复。暂不支持分页、批量事务、自动 GC、永久删除、审计日志、诊断导出、多进程锁、schema 迁移、构画迁移、千千结业务 schema 或任何 UI。

升级时应保持 V1 合同并先备份用户数据；回退只应使用兼容版本，不应把正式数据复制回原型目录。官方/Luker 宿主目录发现方式尚未在本批验证。

`scripts/live-smoke.mjs` 是需另行获授权的真实验收脚本：它通过宿主 CSRF 会话验证 health、创建/读取/更新、409 冲突、删除、回收站和恢复，并会保留一条随机 ID 的极小已恢复测试记录。本批不自动运行该脚本。
