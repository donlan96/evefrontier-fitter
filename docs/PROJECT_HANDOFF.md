# 舰装格局项目交接

当前版本：v1.2.1

发布日期：2026-10-08

状态：Windows 安装包与源码正式版。GitHub Releases 提供 Setup-x64.exe 与 SHA256SUMS.txt。

## 产品与架构

在自定义不规则方格棋盘放置不同形状模块，满足必装、锁定和数量约束后最大化总评分。
当前无账号、云端求解或数据库；算力来自使用者自己的电脑。

- `src/core/`、`src/models/`、`src/utils/`：无 React 依赖的模型、几何、校验与评分。
- `src/components/`、`src/ShipFitterApp.tsx`：页面与交互。
- `src/services/`：本机文件存储和求解 JSON 接口。
- `backend/app/solver/`：合法位置生成、整盘 CP-SAT 模型、回调和校验。
- `src/index.ts`：组件入口；`src/core/index.ts`：独立核心入口。

示例棋盘和模块为演示数据，可自行创建，不是完整游戏数据集。

`resources/starter-content.json` 提供经作者授权的两个默认棋盘（掠夺者 294 格、初始飞船
478 格）与 23 个装备定义；不是完整游戏数据集。只在主存档和备份均不存在时初始化，
已有数据与主动删除的默认内容不覆盖、不合并；损坏存档仍失败关闭。

## 启动与存储

Windows 首次安装步骤见项目 README。安装前端依赖并构建后，双击 `启动配装工具.bat`；
启动器创建本机 Python 虚拟环境并安装依赖，在后台启动服务和打开浏览器。
`停止配装工具.bat` 停止本工具服务，不清除存档；`start-dev.bat` 供开发热更新。

安装包自带 Node、Python 和 CP-SAT；日常通过桌面“舰装格局”与开始菜单“停止舰装格局”
使用。默认安装到 `%LOCALAPPDATA%\Programs\EveFrontierFitter`，个人数据仍在下述应用
目录；升级与卸载保留。打包维护见 [packaging/README.md](../packaging/README.md)。

- 日常前端：`http://localhost:3000`。
- 后端健康：`http://127.0.0.1:8765/api/health`。
- 本机应用目录：`%LOCALAPPDATA%\EveFrontierFitter`。
- 业务存档：`data\fitter-data.json`，schemaVersion 1，内部业务分区 v3。
- Python 虚拟环境：`venv`；日志：`logs`；每次求解的完整诊断：`diagnostics`。

存档采用递增 revision、串行幂等重试、原子写入和有效备份 `.bak`。初次读取失败时只读；
网络保存失败保留内存修改；多页面 revision 冲突停止旧请求并要求重新载入。
主文件损坏可恢复有效备份；主备份都无效时失败关闭。旧 LocalStorage 不读、不迁移、
不删除。命名配装必须明确保存，自动求解与手动调整只产生未保存修改。
建议通过页面 JSON 导出定期备份；导入重新校验版本与完整布局。

## 求解与证明

正式入口仅使用整盘 OR-Tools CP-SAT；必备、锁定、库存、旋转、边界、不重叠为硬约束。
总评分是唯一目标，空间利用率只展示。评分非负、有限、最多三位小数，按千分整数累计。
库存编辑限制为 1～99 的有限整数。仅支持旋转，镜像尚未启用。

手动与历史合法布局作为正 hint 和最低分，不固定未锁定模块。V2 软骨架仅在无完整合法
hint、无锁定且有两份兼容严格最优历史时生成两条大型零分必备模块正 hint；条件不满足
则回退，不删候选、不增加固定约束。独立区域容量约束仍属于整盘安全约束。

默认 8 个搜索线程，可选择全线程或自定义；后端限制为 1 到本机逻辑线程数且最多 256。
线程设置不进入证明指纹。更长时间或更多线程不保证一定更快得到高分或证明。
停止、超时或 UNKNOWN 保留最佳完整方案。服务重启会丢失内存任务，磁盘存档保留。

每个型号保留前五个不同合法布局。历史读取、hint 与应用共用完整合法性复核，失效历史
保留原始记录但不参与当前最佳。严格证明签名 v2 覆盖有效模块、几何、评分、数量规则
和锁定条件；完全禁用的无关模块不影响证明。
只有 OPTIMAL、原始整数目标等于原始 bound 且布局复核通过才记录最优证明。
当前布局与当前有效严格最优历史一致时，配装统计显示“最优”圆章。

## 验证与版本

```powershell
pnpm run check
python -m pip install -r backend/requirements.txt
cd backend
python -m pytest -q tests
```

部分真实规模回归依赖不公开的 `exports/soft-skeleton-v2/static-screen-v2`，缺失时明确
跳过；其余回归不需要用户数据。检查不得清理或覆盖真实存档、导出与诊断。

package.json 是唯一版本源；正式版本同步 CHANGELOG、README、本文件和同名 Git Tag，
由 `pnpm run release:check` 核对。源码主分支更新不等于发布安装包或自动更新用户电脑。

## 开源与限制

v1.2.0 安装包遗漏 React 运行依赖，在没有开发环境的机器上启动失败；请使用 v1.2.1。
打包时补齐锁定版本的 React/React DOM/scheduler，并核对解析路径位于安装目录。
安装验证必须在开发目录之外执行，祖先目录不得含 node_modules，防止掩盖缺包。

仓库：<https://github.com/donlan96/evefrontier-fitter>，MIT 许可证。
初始公开提交为干净源码快照，不含本机旧历史、用户存档、私人实验文档或诊断。
第三方依赖与商标保留原权利；这是社区工具，未获 CCP Games 官方认可。

关闭组件本地持久化的嵌入模式目前无法满足已保存棋盘和命名配装前提，不能提供完整
宿主配装流程。跨设备存储和自动更新尚未实现。
