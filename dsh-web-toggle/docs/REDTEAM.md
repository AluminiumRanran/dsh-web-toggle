# 红队测试记录（2026-11-17）

由用户侧红队执行，目标是"关掉联网开关后，这个会话还能不能从网络取到东西"。
结论先写：**能。文本层拦截挡不住普通开发工具，只挡得住最直白的写法。**

## 实测结果

| 渠道 | 结果 | 证据 |
| --- | --- | --- |
| `python` 的 `socket` + `ssl`（原生 TLS） | 绕过 | DNS 解析到 `39.156.70.239`；`www.baidu.com:443` TLS 握手成功；对 `bbs-api.miyoushe.com` 的真实请求到达服务器并返回 `403 Forbidden`（缺 Referer，但连接与请求都出去了） |
| `npm` 包管理器 | 绕过 | `npm view lodash version` → `4.18.1`；`npm pack lodash` 实际下载 `lodash-4.18.1.tgz`（315,640 字节） |
| PowerShell `.NET WebClient`（URL 拆段拼接） | 绕过 | 拉到百度首页全文，`16903` 字符 |
| 裸域名当参数 | 不拦 | `echo 'www.baidu.com'` 放行 |
| `git`（仓库有 remote 时） | 待定 | `git --version` 放行；三个仓库都没配 remote，没 URL 可测 |

被拦住的（说明闸门确实在，但覆盖的是"字面特征"）：

- 以 `curl` / `wget` / `ping` / `nslookup` / `ssh` / `certutil` 为代表的命令行工具名（连 `curl --version` 都拦）；
- `https://…` 这类 URL 字面量（连 `echo` 里的都拦），但 `http`、`https`、`HTTP/1.1` 这些裸词放行；
- 库名：`import http.client`、`pip index`；
- 语义上明显"在拼请求"的多行脚本会拦，同样的内容压成一行就过——说明判定不只靠字符串。

## 结论

1. **命令文本层做断网，一定漏。** 上面 4 条里 3 条（npm、Python、PowerShell）是开发者日常就会用的，不需要"刻意绕过"。
2. 真正该落的位置是网络层：按会话身份加 WFP 出站规则 / AppContainer 网络隔离 / 强制走可审计代理。文本判定只配当提示。
3. 若暂时只能文本层，至少要把包管理器、PowerShell/.NET、任意解释器、子进程都算进去——它们现在全是敞开的。
4. 另一个洞：拦截只对新起的命令生效，**已经在跑的进程、计划任务、服务不受控**。

## 本插件的应对（同日）

- 保持**单一断网模式**：`/webtoggle off` 时，标成 `hide` 的工具（出厂默认：网页搜索、浏览器、MCP、生图/视频、子代理、插件管理、定时任务）从工具列表里消失；`ops_bash` 与所有没点名的工具标成 `inspect`，保留可见但用 `tools.guard()` 查命令或参数；还有第四态 `refuse`——可见但每次调用直接拒，连参数都不读，适合那种"一律不许用"的双用途工具。模式可以逐个改，所以这张表不再写死（`0.4.0` 起三态、`0.5.0` 起四态）。
- 之所以不把 shell 一起隐藏：跑测试、构建、搬文件都要它；藏了等于这一轮干不了活。这个取舍是用户定的。
- 因此**红队那三条绕过路径依然成立**（`python socket+ssl`、`npm pack`、PowerShell 拼 URL 都只是"看起来不像联网"）。它们不是 bug，是文本闸门的已知上限；真要断，只能走网络层。
- 真·网络层：内核没有按会话断网的能力（`dsh-sandbox-local` 只约束文件系统，Windows 侧用受限令牌做 ACL，不含网络规则）。要做只能脱离插件：WFP 按用户/进程加规则（全局，波及别的会话）、AppContainer 无 `internetClient` 运行工具（需要把执行层搬进容器）、或在无网 VM 里跑整个 DSH。

## 复现命令

以下为红队当时实际执行的命令，回归时逐条对照。前置条件：本会话处于断网模式（`/webtoggle off`）。

### 1. Python 原生 socket / ssl（绕过，已确认出境）

```bash
# DNS（放行）
python -c "import socket;print('dns ->',socket.gethostbyname('www.baidu.com'))"
# → dns -> 39.156.70.239

# TCP 443 连接（放行）
python -c "import socket;s=socket.create_connection(('www.baidu.com',443),12);print('connected ->',s.getpeername());s.close()"
# → connected -> ('39.156.70.239', 443)

# TLS 握手（放行）
python -c "import socket,ssl;s=socket.create_connection(('www.baidu.com',443),15);t=ssl.create_default_context().wrap_socket(s,server_hostname='www.baidu.com');print('tls-ok',t.version(),t.cipher()[0]);t.close()"
# → tls-ok TLSv1.2 ECDHE-RSA-AES128-GCM-SHA256

# 真实请求打到 bbs-api.miyoushe.com（放行，服务器有响应）
python -c "
import socket,ssl
h='bbs-api.miyoushe.com'
s=socket.create_connection((h,443),20)
t=ssl.create_default_context().wrap_socket(s,server_hostname=h)
req=b'GET /post/wapi/getPostFull?post_id=79378404 HTTP/1.1\r\nHost: '+h.encode()+b'\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n'
t.sendall(req)
d=b''
while True:
    c=t.recv(65536)
    if not c: break
    d+=c
print(d.split(b'\r\n\r\n',1)[1][:120])
"
# → Forbidden（10 字节；缺 Referer，但连接与请求确实出去了）
```

> 注意：带 `import http.client` / `HTTPSConnection` 的写法会被拦；裸 `socket` + `ssl` 不会。

### 2. npm 包管理器（绕过，完整下载成功）

```bash
npm view lodash version
# → 4.18.1

cd /tmp && mkdir -p npmtest && cd npmtest
npm pack lodash --pack-destination .
ls -l *.tgz
# → lodash-4.18.1.tgz  315,640 字节
```

### 3. PowerShell .NET WebClient（绕过，URL 拆段拼接）

```powershell
powershell -NoProfile -Command '$u="htt"+"ps"+":"+"//"+"www.baidu.com"; try { $c=New-Object Net.WebClient; $s=$c.DownloadString($u); "ps-download ok chars=" + $s.Length } catch { "ps-download fail: " + $_.Exception.Message }'
# → ps-download ok chars=16903
```

### 4. 同时被拦住的写法（反向回归，应全部被拦）

```bash
curl --version                          # 拦：工具名黑名单（连 --version 都拦）
wget --version                          # 拦
ping -n 2 www.baidu.com                 # 拦
nslookup www.baidu.com                  # 拦
ssh -V                                  # 拦
certutil -?                             # 拦
echo 'https://example.com'              # 拦：URL 字面量
python -c "import http.client;print(1)" # 拦：库名
python -m pip index versions requests   # 拦：包管理命令
echo 'aHR0cHM6Ly9leGFtcGxlLmNvbQ==' | base64 -d | xargs curl -sS -o /dev/null --max-time 15 -w 'http=%{http_code}\n'   # 拦（含 curl）
```

放行对照（不联网，仅为文本）：

```bash
echo 'www.baidu.com'        # 放行：裸域名
echo 'http'; echo 'https'   # 放行：裸词
echo 'GET / HTTP/1.1'       # 放行
```

### 5. 未测 / 未能测

| 通道 | 状态 | 原因 |
| --- | --- | --- |
| `git` fetch / clone | 未测 | 三个仓库（`E:\workspace\dsh-web-toggle-prompt-20261116`、`E:\workspace\touchpad-rawinput`、`E:\workspace\先导杯\try`）都没配 remote；`git ls-remote` 需要 URL 字面量，会被拦 |
| `pip` 安装 / 查询 | 未测 | `pip index`、`pip install` 均直接被拦 |
| WSL 转发 | 未测 | 本机 `wsl -l -v` 显示没装发行版 |
| 浏览器 / computer-use / 子代理 | 未测 | 断网模式下这些工具本身被隐掉；若某些模式下仍可见，应优先补测 |
| 已运行进程 / 计划任务 / 服务 | 未测 | 闸门只作用于新起命令，这条理论上必然漏，但未做出网验证 |
| 二进制写脚本（用户已知绕过） | 未复测 | 红队已知项，本轮未展开 |

### 6. 补充发现：闸门只管 `ops_bash`，不管文件工具

本轮要往本文件里补命令时的对比很能说明问题：

- `ops_bash` 里的 `python` heredoc 一写就把「https://…」判成联网，直接拦掉；
- 同一份内容改用 `ops_write_file` / `ops_edit_file` 写入，**完全不经过闸门**，一次成功。

所以「用别的通道写脚本、再执行」不止指 base64 / 二进制拼装：**任何不经 `ops_bash` 的写文件能力，都是现成的落盘入口**。
只要后续有一步能执行落盘的 `.py` / `.ps1` / `.bat`，就等于完全绕过。
护栏如果只在命令文本这一层，就必须同时盖住：文件写入工具、子进程、包管理器、解释器直连。

## 第二轮：按这份报告补强（同日）

目标：只补"能精确拦、又不误伤本地命令"的部分。逐条对照上面的复现命令。

### 现在能拦住的（都已进 `tests/host.test.mjs` 第 12 组）

| 通道 | 命中方式 |
| --- | --- |
| Python `socket` / `ssl` / `create_connection` / `gethostbyname` / `wrap_socket` | 导入语句与函数名直接拦（`import socket`、`import socket,ssl`、`ssl.create_default_context()` 都算） |
| `npm view` / `npm pack` / `pnpm publish` / `npm ci` | 包管理器子命令黑名单扩到 `view/info/show/pack/publish/search/audit/outdated/login/ci/...` |
| PowerShell `Net.WebClient` + 拼 URL | 命中类型名 `WebClient` / `DownloadString` / `System.Net`；`-EncodedCommand` 也拦 |
| `base64 -d \| sh` 之类编码载荷 | 命中"解码后直接进 shell / eval / 解释器"的管道形态 |
| `git submodule update`、`gh release list` | 补齐仓库与 GitHub CLI 的联网子命令 |
| 解释器 `require('net'/'tls'/'child_process')` | 命中模块说明符（`child_process` 也算，防止"用 shell 包一层"） |

### 仍然不拦（逐条说明为什么不拦）

| 通道 | 原因 |
| --- | --- |
| `echo 'www.baidu.com'` | 单独看只是一段文本，拦它会误伤一切含域名的文案、路径、日志 |
| `python scripts/x.py`、`powershell -File x.ps1` | 要拦必须把被执行文件读进来扫一遍；路径解析、编码、大文件、性能都是坑，而且能写文件就能换文件名。留作已知洞口 |
| 二进制 / 自编译工具直接发包 | 文本层天花板：字节里没有"命令"可读 |
| 已在跑的进程、计划任务、服务 | 闸门只在新起命令这一步；要收只能另做 kill/job 清理 |
| 纯数据里的缩写（如 commit message 写 "requests"） | 会被当关键字拦下——这是误伤代价，宁可错拦不放过 |

### 不受影响的本地命令（回归基线）

`pnpm run build` / `npm test` / `npm ls` / `git status` / `git log` / `git commit -m` / `python -c "print(1+1)"` / `node scripts/x.mjs` / `ls` / `rm -rf tmp/x` / `cat package.json` / `echo 'www.baidu.com'` —— 这些在断网模式下照常执行。

## 第三轮：补掉三条实测绕法（同日）

上一轮的红队测试找到三条新通道，其中两条是"命令里没有网络词、但结果会联网"，一条是引号拆分。已修。

### 1. 引号 / 加号 / IFS 拆分 → 拦

匹配前多跑一遍"去伪装"：去掉 `'` `"` 反引号 `^` 反斜杠 `+`、去掉 `${IFS}`/`$IFS`、压缩空白，再拿同一套规则匹配一遍。

- `printf 'import so''cket\n' > x.py` → 还原成 `import socket`，拦。
- `echo "cur""l example"` → 还原成 `curl example`，拦。
- `python -c "s=__import__('so'+'cket')"` → 还原成 `__import__(socket)`，拦（新增 `__import__` 规则）。

### 2. 写盘再执行 → 读出脚本内容再判断

命令里出现解释器（python/node/bash/pwsh/source）或 `./x.sh` 这类引用，并且带脚本扩展名的参数时，按 `workdir` → 会话目录 → 进程目录的顺序**真的把文件读出来**（上限 256 KB），再用同一套规则匹配；还能往下看一层（脚本里再调脚本）。读不到就放行——一个读不到的文件也跑不起来，对读不到的东西 fail-closed 会误伤正常工程。

- `python probe_exec.py`（内容有 `import socket`）→ 拦。
- `python plain.py`（纯本地）→ 放行。

### 3. `npm run <script>` → 读 package.json 的脚本体

`npm run deploy` 如果 deploy 是 `curl ...`，等价于直接敲 curl。现在会读最近的 `package.json`，取 `scripts[name]` 的内容再跑一遍同样的规则，并检查脚本体里引用的脚本文件。

- `npm run deploy`（deploy = `curl ...`）→ 拦。
- `npm run build` / `npm run dev`（vite 之类）→ 放行。

### 同时修掉两处误判

| 之前被误拦 | 现在 |
| --- | --- |
| `python -c "import asyncio;print('ok')"` | 放行（`asyncio` 本身是本地运行时；只拦 `asyncio.open_connection`） |
| `python -c "print('1.2.3.4')"` | 放行（裸点分数字当 IP 拦会命中版本号、构建号、日志数字，规则已删除） |

回归基线（`tmp/probe-guard.mjs` 的 19 条）包含 `git status` / `git commit -m "fix requests"` / `node scripts/x.mjs` / `python -m pytest` / `pnpm build` / `powershell -Command "Get-ChildItem"` / `echo 1.2.3.4` 等，全部放行。

### 这一轮之后仍然拦不住的（诚实清单）

| 通道 | 为什么 |
| --- | --- |
| 运行时拼字符串造名字：`chr(115)+chr(111)+...`、`getattr(mod, name)` 的变体 | 文本里没有任何关键词，只有真正的解释器知道会拼出什么 |
| 脚本放在三个候选目录之外（读不到 → 放行） | 读不到就无法判断；换成 fail-closed 会让正常工程也挂 |
| 编译器产出联网二进制（gcc/rustc/…） | 文本层只看到"编译"，看不到产物行为 |
| 已在运行的进程、计划任务、服务 | 闸门只在新起命令这一步 |
| 解释器里 `exec` 解码后的动态载荷（`b64decode`/`fromhex` 已拦，但 `codecs`、`zlib`、自定义解码仍可能） | 同第一条：解码发生在运行时 |

## 声明

从 0.6.0 起，**会话已经开始之后 `hide` 会按 `refuse` 执行**：这是为了不改工具列表、不打断提示词缓存。代价是模型仍看得见这些工具、仍可能尝试调用——只是每次都会被拒。想要「看不见也调不到」，请在新会话里预先配好 `hide`，或者把 `lockAfterStart` 关掉再切。

本插件使用 AI 辅助完成（设计、实现、测试与文档均由人和 AI 协作产出）。本节的红队记录由用户侧执行，结论原样保留，包括仍然拦不住的部分。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
