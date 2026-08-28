# ST-BaiNiaoData

`ST-BaiNiaoData` 是 SillyTavern 服务端插件仓库，插件 ID 为 `st-bainiaodata`，显示名为 `Bainiao Data`，中文名为“白鳥数据后端”。它是一个无 UI、零第三方运行时依赖的 V1 数据后端：数据保存在用户自己的 SillyTavern 服务器上，不上传到作者服务器。

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

当前 Luker `release` 已真实加载并完成完整 smoke 验证。官方原生安装方式目前仅依据当前参考源码确认 loader 合同，尚未进行独立的真实运行 smoke，不应据此推断其运行验证已经完成。

## 存储与能力

数据保存在用户根目录下的相对位置：

```text
.st-bainiaodata/storage-v1/records/...
.st-bainiaodata/storage-v1/system-trash/...
```

每个用户使用自己的 SillyTavern 用户根目录，用户之间相互隔离；`namespace` 只提供逻辑隔离，不是安全权限边界。

已支持：记录创建、读取、更新、删除与列表；revision 乐观并发；单文件临时写入后原子替换；回收站与恢复。

暂不支持：分页、批量事务、自动 GC、永久删除、审计日志、诊断导出、多进程锁、schema 迁移、构画迁移、千千结业务 schema 或任何 UI。

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
