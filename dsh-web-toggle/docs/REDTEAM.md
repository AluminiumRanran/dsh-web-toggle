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

- 默认断网（`/webtoggle off`，点按钮也是这个）= **严格**：`ops_bash` 一起隐藏，只留纯本地工具。红队那几条路径里，除了"关之前就在跑的进程"，其余都因为工具本身不存在而失效。
- `/webtoggle local` = **宽松**：`ops_bash` 保留 + 命令过滤。文档与命令回执都写明"这是文本过滤，能绕"，只用于"要跑本地命令又不想明显联网"的场景。
- 真·网络层：内核没有按会话断网的能力（`dsh-sandbox-local` 只约束文件系统，Windows 侧是用受限令牌做 ACL，不含网络规则）。要做只能脱离插件：WFP 按用户/进程加规则（全局，会波及别的会话）、AppContainer 无 `internetClient` 运行工具（需要把工具执行搬进容器）、或在无网 VM 里跑整个 DSH。

## 复现命令

> 待补：请把红队当时实际用的命令原样贴进来（尤其是 Python TLS、`npm pack`、PowerShell 拼 URL 三段），方便以后回归。
