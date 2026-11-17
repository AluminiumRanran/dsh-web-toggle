# dsh-web-toggle

为 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）对话输入框工具栏加一个**按会话独立**的断网开关：点灭之后，本会话的模型看不到 `web_search` / `web_fetch`、浏览器、MCP、子代理等一切能出网的工具，`ops_bash` 保留但联网命令会在执行前被拦下；再点一次恢复。只影响这一个会话。

![位置：输入框左边的小地球](dsh-web-toggle/icon.svg)

## 安装

**方式一：单个 tgz（发行版）**

从 [Releases](../../releases) 下载 `dsh-web-toggle-0.1.0.tgz`，然后在 DSH 里：

```
plugin_manager install_bundle target="file:/绝对路径/dsh-web-toggle-0.1.0.tgz"
```

**方式二：从源码目录**

```bash
git clone <this repo>
# 在 DSH 里：
# plugin_manager install_bundle target="file:/绝对路径/dsh-web-toggle-20261116/dsh-web-toggle"
```

装完**刷新页面**（客户端模块要重新下发）。要求 DSH `>= 0.2.2-rc.1 < 0.3.0`。

## 用法

输入框左边会多出一个小地球按钮，亮 = 联网开启，灭 = 已断网。也可以用命令：

```
/webtoggle          切换
/webtoggle on|off   显式开关（幂等）
/webtoggle status   只读状态
```

轮次正在执行时会被拒绝，等这一轮结束再点。

## 它做什么

- 用内核自带的 `agent.ctx.tools.restrict({ allow })` 做**白名单**：只留不能出网的工具，其余全部隐藏。作用域绑定在 agent 上，所以按会话隔离、可逆。
- `ops_bash` 单独保留，用 `agent.ctx.tools.guard()` 做命令过滤（三层：字面匹配、去引号/加号/IFS 伪装后再匹配、读出要执行的脚本和 `npm run` 的脚本体再匹配）。
- 拒绝理由写成**给模型的指令**：不要换工具、不要写脚本或编码后执行、不要起子进程找替代通道；真需要联网就停下请用户打开开关。

## 它挡不住什么

这是**提示性护栏，不是网络层的墙**。DSH 内核没有按会话断网的能力（沙箱只约束文件系统），所以运行时拼出来的模块名、编译出的二进制、放在读不到路径里的脚本、已经在跑的进程，都能绕过去。真要一个字节都不许出，只能在无网 VM/容器里跑 DSH。

设计细节、红队记录、真机验证见 [`dsh-web-toggle/docs/`](dsh-web-toggle/docs/)。

## 目录

```
dsh-web-toggle/     插件源码（Host 半侧 index.js、Browser 半侧 client.js、patch、locale、图标）
dsh-web-toggle/docs/设计细节、红队记录、验证清单
dsh-web-toggle/tests/离线测试（host 12 组、client 8 组）
PROMPT.md           最初的实现要求（保留作为设计背景）
```

## 许可

MIT，见 [`dsh-web-toggle/LICENSE`](dsh-web-toggle/LICENSE)。
