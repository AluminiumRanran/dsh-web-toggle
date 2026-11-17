# dsh-web-toggle

为 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）对话输入框工具栏加一个**按会话独立**的断网开关：点灭之后，本会话里标成「隐藏」的工具从模型眼前消失（出厂默认包括 `web_search` / `web_fetch`、浏览器、MCP、子代理、插件管理、定时任务），`ops_bash` 这类通用执行器保留但每次调用前过一遍联网内容检查，**其余工具照常可用**；再点一次恢复。只影响这一个会话。

每个工具有三种模式：`keep`（保留）/ `hide`（隐藏）/ `inspect`（保留但检查内容）。出厂只标例外、不维护白名单——所以没见过的工具默认放行，不会误伤。

![位置：输入框左边的小地球](dsh-web-toggle/icon.svg)

## 安装

**方式一：单个 tgz（发行版）**

从 [Releases](../../releases) 下载 `dsh-web-toggle-0.4.0.tgz`，然后在 DSH 里：

```
plugin_manager install_bundle target="file:/绝对路径/dsh-web-toggle-0.4.0.tgz"
```

**方式二：从 npm**

```
plugin_manager install_bundle target="dsh-web-toggle@0.4.0"
```

**方式三：从源码目录**

```bash
git clone <this repo>
# 在 DSH 里：
# plugin_manager install_bundle target="file:/绝对路径/dsh-web-toggle-20261116/dsh-web-toggle"
```

装完**刷新页面**（客户端模块要重新下发）。要求 DSH `>= 0.2.2-rc.1 < 0.3.0`。

## 用法

输入框左边会多出一个小地球按钮，亮 = 联网开启，灭 = 已断网；旁边的小箭头打开本会话面板，里面能逐个工具改模式。也可以用命令：

```
/webtoggle                        切换
/webtoggle on|off                 显式开关（幂等）
/webtoggle status                 只读状态
/webtoggle tools                  列出全部工具与各自模式
/webtoggle mode <tool> keep|hide|inspect [--global]
/webtoggle mode reset [--global]
```

轮次正在执行时会被拒绝，等这一轮结束再点。

## 它做什么

- 用内核自带的 `agent.ctx.tools.restrict({ deny })` 做**例外表**：断网时只 deny 那些标了 `hide` 的工具，`inspect` 的工具照常可见。作用域绑定在 agent 上，所以按会话隔离、可逆。
- `inspect` 模式的工具（默认 `ops_bash`）用同一作用域的 `agent.ctx.tools.guard()` 做内容检查（三层：字面匹配、去引号/加号/IFS 伪装后再匹配、读出要执行的脚本和 `npm run` 的脚本体再匹配）。
- 拒绝理由写成**给模型的指令**：不要换工具、不要写脚本或编码后执行、不要起子进程找替代通道；真需要联网就停下请用户打开开关。
- 模式分「本会话 / 全局 / 出厂默认」三层，界面改动即时生效。

## 它挡不住什么

这是**提示性护栏，不是网络层的墙**。DSH 内核没有按会话断网的能力（沙箱只约束文件系统），所以运行时拼出来的模块名、编译出的二进制、放在读不到路径里的脚本、已经在跑的进程，都能绕过去。真要一个字节都不许出，只能在无网 VM/容器里跑 DSH。

设计细节、红队记录、真机验证见 [`dsh-web-toggle/docs/`](dsh-web-toggle/docs/)。

## 目录

```
dsh-web-toggle/     插件源码（Host 半侧 index.js、Browser 半侧 client.js、patch、locale、图标）
dsh-web-toggle/docs/设计细节、红队记录、验证清单
dsh-web-toggle/tests/离线测试（host 16 组、client 14 组）
PROMPT.md           最初的实现要求（保留作为设计背景）
```

## 许可

MIT，见 [`dsh-web-toggle/LICENSE`](dsh-web-toggle/LICENSE)。

## 声明

本插件使用 AI 辅助完成（设计、实现、测试与文档均由人和 AI 协作产出，并经真机红队测试）。它的定位是**提示性护栏**，不是网络隔离，发布前请自行复核是否满足你的安全要求。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
