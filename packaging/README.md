# Windows 安装包构建

v1.2.0 起，GitHub Releases 提供 Windows x64 安装包。使用者无需安装 Node.js 或 Python。
安装目录与个人存档分离；卸载不删除 `%LOCALAPPDATA%\EveFrontierFitter`。

## 默认内容

`resources/starter-content.json` 只包含经作者授权公开的棋盘几何和装备定义，使用公开预设
ID。它不包含个人配装、历史、最优证明或诊断。默认内容只在主存档和备份都不存在时
初始化，已有数据和损坏失败关闭不受影响。

维护者需要更新这些预设时，应先获得对应内容公开授权，再显式运行
`export-starter-content.py --input <已授权存档> --output resources/starter-content.json`。
普通构建仅读取已审查的公开资源文件，不自动读取维护者的本机存档。

## 构建环境

Windows x64，Node.js 22.13+、pnpm 11.17.0、Python 3.12、Inno Setup 6.7.3。
在英文路径的 checkout 中创建独立构建环境：

```powershell
pnpm install --frozen-lockfile
py -3.12 -m venv work/build-venv
work/build-venv/Scripts/python.exe -m pip install -r packaging/requirements-runtime.txt
pnpm run check
cd backend
../work/build-venv/Scripts/python.exe -m pytest -q tests
cd ..
packaging/build-windows.ps1 -PythonExe "$PWD/work/build-venv/Scripts/python.exe" -IsccExe "C:/Program Files (x86)/Inno Setup 6/ISCC.exe" -SkipFrontendBuild
```

产物位于 `outputs/releases/`。构建使用 vinext standalone、PyInstaller onedir 与 Inno
Setup；前端依赖由 pnpm-lock.yaml 固定，已验证的 Python 运行库和打包器由 requirements-runtime.txt 固定。
Node 二进制在打包前对照 nodejs.org 官方 SHA-256 校验；运行库许可证随安装目录提供。
`build-manifest.json` 保留本次运行库版本、安装包大小及校验值。

v1.2.0 的 standalone 输出遗漏 vinext 服务自身导入的 React peer 依赖。v1.2.1 起，
`prepare-web-runtime.mjs` 补齐锁定版本的 React/React DOM 及其生产依赖（scheduler），
检查运行依赖解析路径均位于包内，并预加载网页服务；检查失败则不生成安装包。

默认日常地址是 `http://localhost:3000`，求解器只监听 `127.0.0.1:8765`。
启动器核对可执行文件路径和进程创建时间，停止时不结束其他程序或 PID 已复用的进程。
遇到其他程序或旧源码版占用端口时提示用户先关闭，不自动混用服务。

测试可通过 `--no-browser --data-root <独立测试目录> --frontend-port 13000 --solver-port 18765`
启动冻结包，用于检查文件加载、后端、持久化和原生 CP-SAT。浏览器 UI 的默认 API 地址
仍固定为 8765，备用测试端口不作为公开产品入口。测试不得使用真实用户目录。

必须把安装目录放在开发 checkout 之外的独立临时目录，祖先目录不得含 node_modules。
`smoke-windows.py` 会拒绝不隔离的安装路径，并清除 NODE_PATH/NODE_OPTIONS/Python 查找
变量。测试实际安装后的网页脚本、求解和存档保留；仅缩减 PATH 不能排除祖先依赖。

## 发布

同步版本号、CHANGELOG、README、交接文档，检查公开提交无用户存档及秘密，创建同名
`vX.Y.Z` Tag 和 GitHub Release，上传 Setup-x64.exe 与 SHA256SUMS.txt。
安装包未附代码签名证书；SHA-256 用于核对下载文件，不等同于签名或安全信誉。
公开源码采用 MIT；第三方运行库各自的许可证仍有效。中文安装语言文件来自
[Inno Setup 官方仓库](https://github.com/jrsoftware/issrc/blob/is-6_7_3/Files/Languages/Unofficial/ChineseSimplified.isl)，
保留其来源与版权，参见 INNO-SETUP-LICENSE.txt。
