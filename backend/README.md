# 本地 CP-SAT 求解服务

自动配装现在完全由本机 Python 服务中的 Google OR-Tools CP-SAT 完成。该服务同时负责本机 JSON 文件存档，只监听 `127.0.0.1:8765`，不使用公网、账号或数据库。独立端口可避免与 EVE Frontier 资料站常用的 `8000` 端口冲突。

## 推荐启动方式

日常使用双击项目根目录的 `启动配装工具.bat`。脚本会在 `%LOCALAPPDATA%\EveFrontierFitter\venv` 检查或创建虚拟环境，在依赖变化时更新组件，并在后台启动求解器与本地网页。使用完毕后双击 `停止配装工具.bat`。

后台日志保存在 `%LOCALAPPDATA%\EveFrontierFitter\logs`。需要热更新和实时终端日志时才使用 `start-dev.bat`。

虚拟环境刻意放在纯英文的本机应用数据目录，避免 Windows Python 在包含中文的项目路径中创建 venv 时出现启动兼容问题。

## 手动启动

在 PowerShell 中执行：

```powershell
$venv = "$env:LOCALAPPDATA\EveFrontierFitter\venv"
py -3 -m venv $venv
& "$venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
$env:PYTHONPATH = "backend"
& "$venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload --app-dir backend
```

另开一个终端运行 `pnpm run dev`。

## 接口

- `GET /api/health`：健康检查；
- `GET /api/data`：读取本机文件存档及主文件/备份来源；
- `PUT /api/data`：按递增 revision 原子保存完整存档；
- `POST /api/solver/solve`：创建后台求解任务；
- `GET /api/solver/status/{jobId}`：读取实时最佳方案、best bound、差距与状态；
- `POST /api/solver/stop/{jobId}`：停止搜索并保留停止前最佳方案。

`POST /api/solver/solve` 可选传入 `searchWorkers`：`{"mode":"standard"}` 使用默认 8，
`{"mode":"all"}` 使用后端检测到的本机逻辑线程数，`{"mode":"custom","value":12}`
请求自定义线程数。旧请求省略该字段时仍使用标准 8。后端会把实际值限制在 1、本机逻辑
线程数与 256 的绝对安全上限之间；任务响应返回 `effectiveSearchWorkers`、
`logicalCpuCount` 和 `searchWorkersClamped`。线程数仅影响 CP-SAT 搜索参数，不改变模型或
最优性语义。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8765/api/health
```

## 本地求解诊断

每次自动配装都会在 `%LOCALAPPDATA%\EveFrontierFitter\diagnostics` 写入一份 JSON 诊断文件，包含本次精确请求、各模块合法摆放数量、模型变量与约束数量、评分上界变化、最佳方案变化，以及停止时的分支和冲突统计。`model.searchWorkers` 记录 requested 模式/数值、effective workers、逻辑线程数、默认值和 clamp 状态；`model.softSkeleton` 还记录 V2 是否启用、停用原因、训练来源、形状与候选索引、正 hint 数、决策策略和生成耗时。诊断与业务存档相互独立，求解服务重启后仍永久保留，不再自动删除旧文件。

## 本机业务存档

业务数据保存在 `%LOCALAPPDATA%\EveFrontierFitter\data\fitter-data.json`，顶层使用 `schemaVersion` 和递增 `revision`。服务会校验 v3 棋盘、配装、求解历史和工作区的关键嵌套结构，再在同目录写入并同步临时文件，复核后原子替换主文件；覆盖前把上一份有效主文件保存为 `fitter-data.json.bak`。主文件 JSON 或嵌套结构损坏时读取有效备份，后续修复写入不会用损坏主文件覆盖备份；主备份均无效时返回失败，不生成默认覆盖。旧浏览器 LocalStorage 不会读取、迁移或删除。

## 测试

```powershell
$env:PYTHONPATH = "backend"
& "$env:LOCALAPPDATA\EveFrontierFitter\venv\Scripts\python.exe" -m pytest backend\tests -q
```

请求和响应使用独立 Pydantic 模型，不依赖 React。CP-SAT 对每个合法摆放建立布尔变量，约束格子互斥、必备数量、候选上限、库存、锁定位置和独立区域容量；唯一优化目标是最大化总评分，利用率与剩余格仅作为结果统计。手动布局与历史最佳仅将实际选中的位置作为正向 hint 和初始最佳，不会把其余候选写成排除提示，也不会成为锁定约束。没有合法完整布局 hint 和锁定模块时，服务可从两份兼容的其他严格最优历史中生成恰好两条大型零分必备模块正 hint；生成失败即完全回退，不加零值 hint、约束或候选删减。求解前使用模块整数数量与面积计算安全评分上限，供界面和诊断使用而不作为改变搜索路径的显式约束；合法历史最佳分数仍用于排除更低分方案。求解器在同一次运行中持续寻找更高分方案并收紧 Best bound，并以 CP-SAT 返回的 `OPTIMAL` 状态报告已证明最优。
