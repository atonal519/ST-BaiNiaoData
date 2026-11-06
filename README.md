# ST-BaiNiaoData

`ST-BaiNiaoData` 是 SillyTavern 服务端插件仓库，插件 ID 为 `st-bainiaodata`，显示名为 `Bainiao Data`，中文名为“白鳥数据后端”。它是一个无 UI、零第三方运行时依赖的 V1 数据后端：数据保存在用户自己的 SillyTavern 服务器上，不上传到作者服务器。

当前版本 **0.2.0**，新增回收站到期清理，以及管理员查看和更新服务端插件的接口；保留 V1 记录、批量读写和恢复合同。更新后重启酒馆加载。

## 前置配置

在酒馆根目录的 `config.yaml` 中确认服务端插件已启用：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: true
```

修改配置后按宿主提示重启酒馆。

## 安装

### Luker

在 Luker 的后台服务端插件管理界面粘贴公开仓库 URL：

```text
https://github.com/atonal519/ST-BaiNiaoData.git
```

安装完成后重启酒馆。具体按钮名称和界面布局以当前 Luker 版本为准。

### 官方原生 SillyTavern

在 SillyTavern 根目录执行：

```bash
git clone https://github.com/atonal519/ST-BaiNiaoData.git plugins/ST-BaiNiaoData
```

然后重启酒馆。不需要执行 `npm install`。

两套宿主都直接发现插件仓根的 `index.mjs`，不需要额外的顶层 loader。

## 更新

开启 auto update 后，宿主会在启动阶段更新插件跟踪的分支。

也可以手工更新：

```bash
cd /path/to/SillyTavern/plugins/ST-BaiNiaoData
git pull --ff-only
```

更新后重启酒馆。后端更新应低频进行；前端普通功能迭代不应要求同步更新后端。

## 验证

健康检查路径为：

```text
/api/plugins/st-bainiaodata/v1/health
```

浏览器直接访问可能受到登录或 CSRF 保护影响；插件前端应通过宿主会话发起请求。

更新并重启后，健康检查中的 `plugin.version` 应为 `0.2.0`，`capabilities.trashGc` 和 `capabilities.serverPluginManagement` 应为 `true`。开发验证可运行 `npm test` 与 `npm run check`；测试使用临时目录、模拟宿主和本地 Git 仓库。

## 存储与能力

数据保存在用户根目录下的相对位置：

```text
.st-bainiaodata/storage-v1/records/...
.st-bainiaodata/storage-v1/system-trash/...
```

每个用户使用自己的 SillyTavern 用户根目录，用户之间相互隔离；`namespace` 只提供逻辑隔离，不是安全权限边界。

已支持：记录创建、读取、更新、删除与列表；版本 0.1.1 提供可选的记录 ID 清单和最多 64 条的批量读取；revision 乐观并发；单文件临时写入后原子替换；回收站与恢复；用于清理旧版本的独立永久删除入口（不进入回收站）。新增 `POST /v1/trash/:namespace/collect-expired` 按 `expiresAt` 清理回收站，每次最多检查 32 项并返回计数和续查游标，由客户端按需触发。批量读取只减少往返次数，不提供批量写入事务。旧后端不执行回收站到期清理；需更新到本版本并重启酒馆后生效。

暂不支持：分页、批量事务、后台常驻 GC、审计日志、诊断导出、多进程锁、schema 迁移、构画迁移、千千结业务 schema 或任何 UI。

## Live smoke

`live smoke` 仅用于开发或排障，会留下一个极小的随机 ID、已恢复的测试记录。运行前必须事先取得用户授权；本 README 不代表已经获得授权。

在开发仓执行：

```bash
node scripts/live-smoke.mjs <宿主基址>
```

例如宿主基址为 `http://127.0.0.1:8000` 时：

```bash
node scripts/live-smoke.mjs http://127.0.0.1:8000
```

## 回退与卸载

回退到兼容版本前先备份用户数据。卸载时先停止酒馆，或先将插件目录移出 `plugins/`，再重启酒馆；保留用户根目录中的 `.st-bainiaodata` 数据目录。不要通过设置 `enableServerPlugins: false` 来关闭全部服务端插件。

回退只应使用兼容版本，不要把正式数据复制回旧原型目录。

## API 与版本

宿主基址为 `/api/plugins/st-bainiaodata`，内部路由统一使用 `/v1`。当前 API 版本为 `1`，程序版本见插件 manifest；升级时应保持 V1 合同并先备份用户数据。

### 有界批量保存

`PUT /v1/record-batch/:namespace/:collection` 接受 `{records:[{recordId,data,expectedRevision}]}`。每批最多64条，完整规范JSON请求体UTF8最多1MiB；全部参数、重复ID和体积在写入前校验。后端最多4条并发，沿每条记录原有CAS和原子文件替换，按输入顺序返回成功envelope或逐项错误；成功项保留。health的`recordBatchWrite`标识此能力，超大单条仍使用原单记录PUT。

### 回收站到期清理

`POST /v1/trash/:namespace/collect-expired` 接受 `{limit:32,cursor:null}`，`limit` 为1至32，后续批次传入返回的 `nextCursor`。响应包含 `scanned`、`deleted`、`failed`、`nextCursor` 和 `complete`。仅清理当前用户、指定 namespace 内已到 `expiresAt` 的回收项，保留现用记录和未到期项；每项清理前重新检查归属与到期时间。

### 管理员服务端插件管理

`POST /v1/admin/plugins/list` 返回已安装插件的名称、版本、依赖状况和可更新状态；`POST /v1/admin/plugins/update` 接受 `{directory:"插件目录名"}`，更新指定插件。两接口要求宿主当前账号的 `profile.admin` 为 `true`，普通用户返回403。

列表只读取元数据，不加载插件代码或拉取远端。更新限 `plugins/` 直属的独立 Git 仓库，按该仓已配置的上游执行 `git pull --ff-only`；有本地修改、没有上游或分支分歧时停止并返回原因。更新结果重新读取磁盘版本，代码变化时返回 `restartRecommended:true`，由管理员重启酒馆加载。依赖情况仅作提示；接口不安装依赖，不安装或卸载插件，也不自动重启服务。
