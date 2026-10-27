# Linux / Web profile fork notes

本 fork 由 `ahian-lee/dsh-ssh-workspace`(其上游为 `Yan-Zero/dsh-remote-ssh` 0.2.4)派生,
目标是让它在 **Linux 本地主机 + `dsh web` profile** 上工作,而不是原先的 Windows Desktop + 远端 Linux。

许可证保持 Apache-2.0,原始署名见 `LICENSE` / `NOTICE` / `DESKTOP-COMPAT.md`。

## 本地(Linux)适配

### 1. 本地执行世界改用 bash 提供方

`cordis.patch.yml` 的 `remote-ssh-local-world` 原本把 `@deepseek-ai/dsh-pwsh-sandbox` 作为
`local-shell`。这是 Windows 桌面构建的假设。改为 `@deepseek-ai/dsh-bash-sandbox`。

> 注意:插件源码本身已经跨平台 —— `src/routing/manager.ts` 的 `dialectFor()` 在非 `win32` 上
> 返回 `bash`,所以这是组合层的单点改动,不涉及代码逻辑。

### 2. 移除对不存在的 `agent-presets` 行的注入

补丁末尾原本有:

```yaml
- id: agent-presets
  inject: [remoteSshSearchHook]
```

`agent-presets` 是上游桌面 profile 才有的行;`@deepseek-ai/dsh-base` + `dsh-web-app` 组合里没有它,
保留会导致 `patch: entry "agent-presets" not found`。此处注释停用。

**回归条件**:若将来 profile 出现该行,应恢复这行注入 —— 它用于把 preset 花名册压到
`remoteSshSearchHook` 之后挂载,保证 `tool-fs-search` 从第一次 import 起就走远端感知路径。

## 安装方式(本 fork 用 `link:`)

`file:` 安装是**拷贝**,改完 `cordis.patch.yml` 不会生效。开发期使用:

```sh
dsh plugin --profile <profile> add link:/path/to/this/fork
```

`link:` 会从仓库真实路径解析模块,因此仓库**必须有**自己的 `node_modules` 才能解析运行时依赖
`@microsoft/agent-host-protocol`:

```sh
cd /path/to/this/fork
npm i --omit=dev --no-save --no-package-lock --legacy-peer-deps @microsoft/agent-host-protocol@0.7.0
```

(`--legacy-peer-deps` 必需:包的 `peerDependencies` 覆盖了整套 `@deepseek-ai/dsh-*`,
直接安装会 ERESOLVE。)

## 隔离测试 profile(不碰生产 profile)

测试用**独立 `DSH_HOME`**,profile 与 session 全部落在仓库工作区内,物理上无法影响其它 profile:

```sh
export DSH_HOME=/home/ailab/ddr54_ip/.dsh-sshws
mkdir -p "$DSH_HOME" && cp ~/.dsh/.credentials.yaml "$DSH_HOME/"

# 从内置 web 模板派生一个新 profile
node .../dsh/lib/bin.js --profile sshws --from-default-profile web --dump-default-config >/dev/null

# 装入本 fork 并校验组合(不启动)
node .../dsh/lib/bin.js plugin --profile sshws add link:/path/to/this/fork
node .../dsh/lib/bin.js --profile sshws --dump-config

# 启动(随机端口,不打开浏览器)
node .../dsh/lib/bin.js --profile sshws --port 0 --no-open
```

启动成功的判据:日志里**没有** `failed to import` 与 `entries did not activate`,并且首页的
plugin 列表包含 `dsh-ssh-workspace/client.js`。

## 远端前置条件(本 fork 尚未解决)

远端工作区通过 **AHP(Agent Host Protocol)** 路由 `fs` / `search` / `subprocess` / `jobs` / `terminal`,
远端必须能跑:

```sh
code agent host --host 127.0.0.1 --port 0 --idle-timeout 60 \
  --server-data-dir "$HOME/.dsh-ssh-workspace/server" \
  --cli-data-dir "$HOME/.dsh-ssh-workspace/cli" --verbose
```

详见 `src/transport/runtime.ts`(bootstrap 顺序:`PATH` 上的 `code` → 私有 CLI
`$HOME/.dsh-ssh-workspace/cli/bin/code` → 远端缓存的 VS Code Server `code-server`)。

同时需要 `bash`、`base64`、`mkfifo`、`rg`。

实测(2026-10-27):

| 主机 | `agent host` | `rg` | 备注 |
|---|---|---|---|
| ampere | ✗(`code` 1.90.1,无 `agent host` 子命令) | ✓ | 已有 `~/.dsh-ssh-workspace/` 与 `~/.vscode-server/` |
| spr | ✗(无 code) | ✓ | |
| datanode | ✗(无 code) | ✗ | |
| kunpeng | ✗(无 code) | ✗ | |

**因此当前可验证的范围是:插件在 Linux/Web 下正确组合、启动、注册客户端 UI,以及 LOCAL 执行世界可用。**
远端工作区要等远端具备 `code agent host` 后才能验证。
