# 兼容验收矩阵

## 使用方式和证据等级

逐条核对，不用“测试全绿”替代逐项结论。来源完整 hash 在 [历史清单](history.md)。位置相对仓库根；函数名/测试名是搜索锚点，不承诺新 bundle 行号不变。

每次输出一行结果：ID｜历史 hash｜新包证据（文件/函数或原始包差异）｜保留/等价替代/废弃/待验证｜本次测试｜缺口。只有行为证明等价才可删补丁；废弃必须有后继来源。下表的检查动作不是已全部实测的声明。

证据分层：S＝静态/契约；F＝提取真实 bundle 函数+模拟依赖；N＝系统 Node 实际进程/MCP；D＝正式或 Beta Cindy 的真实打包安装。F 不覆盖真实网络/扣费，N 不覆盖 Electron Host；历史 D 不传递到新版本。

## Runtime 补丁与调用链

| ID / 来源 | 最终保护与定位 | 每次升级的具体检查与验收 |
| --- | --- | --- |
| V1 / ff54f59、577da80；0.0.37 增量 | vendor/dist/maker.js：normalizeRemoteProxyExecutionState、getRemoteProxyExecutionState、addRemoteProxyErrorExecutionState；三态穿透。 | 分别输入 executed/not_executed/unknown，含 structuredContent、文本 JSON、remote_result 包装；unknown 优先，已执行与未执行冲突返回 unknown。对照最终宿主结果，不能只断言包含 executed 字符串。测试搜索“Runtime 错误包装”“保留远端错误结果”；F + 宿主模拟。 |
| V2 / a5d85df、431213e | BLACKLISTED 调用拦截保留原消息，structuredContent success:false / execution_state:not_executed。 | 确认拦截发生在 dispatch 前，实际 call 次数为零，最终结果仍结构化未执行。不能恢复只在顶层放 state 的中间方案；测试“BLACKLISTED 列表短路和调用拦截”；F + 宿主模拟，真实受限账号另做 D。 |
| V3 / 2a80b28 | startMakerMcpServer 中列表、资源读取、调用按请求 resolveMakerMcpAccessState，不缓存启动期 promise。 | 检查三个入口，而非只 tools/call；同实例换 PAT/限制状态的下一次请求重新判定；鉴权请求失败不擅自当 BLACKLISTED。现有“不缓存黑名单”是 S，“仅在明确 BLACKLISTED”是 F，真实热切换仍需 D。 |
| V4 / d54ef28、c0e3c5b、6c4f223、78e795b、da7f978、a352bde、2259e38 | 受限 tools/list 返回固定工具和 _meta.maker_access；main.js listMakerTools/handleTool 返回账号原因而非“工具不存在”。 | 列表和调用前 list 都短路，reason/message 脱敏，not_executed/automatic_retry:false；普通不存在工具也明确未发送；四语言及 Manual 表述一致。F + 宿主模拟/S；不为显示更多工具解除账号限制。 |
| V5 / a506b40、6c4f223 | assertSafeUserSkillRoots 在 pull 下载前、installUserSkills、installUserSkillsForClients 写前调用。 | .installer/skills、.codex/skills、.cursor/skills、.workbuddy/skills 每级祖先已有 symlink 时拒绝；正常目录仍可用。确认路径/fs/exists 打包别名正确，测试运行新包实际函数。F/本地文件测试不能宣称解决所有 TOCTOU 或任意祖先路径风险。 |
| V6 / e4e5f63、aec91dd、891868e；0.0.37 增量 | 通用不可逆请求不重放，MAC 失效仅明确 not_executed 可重试一次。 | 检查 callRemoteProxyTool、manager/direct transport、proxy pending queue、重连和外层重试，不能只查 confirm_character_voice。初始化前失败与派发后断线分别测；executed/unknown/缺状态/冲突不自动重试；第二次失败不得第三次发出。测试“MAC 失效只重试明确未执行”；F，真实故障/扣费需授权后 D。a3d295d 原 diff 仍缺失。 |
| V7 / c58a81a；0.0.37 增量 | Console 实例身份包含版本、分发来源、入口路径。 | 同版本 standalone、同版本另一插件目录不能被当当前 Cindy 服务复用；正确同入口仍可复用。检查身份生成与 health 验证两端，不只改文件名。测试“不会复用同版本”；F/N，跨会话并发和停服所有权需 D。 |
| V8 / 0.0.37 用户确认的最小策略 | cindy_plugin 下 getConsoleHtml 无模型设置入口、readModelSettings 返回空配置；configured/resolvedUiVisionModels 固定 Server；写 models/ui-vision API 拒绝。 | 页面加载没有残留按钮空引用；GET 不露自定义密钥，非 GET 不写配置，Server 不可用明确 503；不降级 chatgpt-web，standalone 分支原行为不变。测试“识图固定 Server”，加隔离 HOME 真实 HTTP 冒烟。没有旧配置迁移、生成桥接或素材开关跨进程接管。 |

## Host / 进程层

| ID / 来源 | 最终保护与定位 | 每次升级的具体检查与验收 |
| --- | --- | --- |
| H1 / 41d53ce、2407dd5、891868e | maker-mcp.cjs、maker-child.cjs 固定入口、cindy_plugin 注入；adapter 只改道自身 process.execPath + makerEntry，proxy JSON 配置用既有参数。 | 非固定脚本拒绝；__maker-proxy 仍走 spawnEntry；不开放任意 env/命令能力，不把全局 CLI/npm 更新建议带回托管包。检查新版本新增 spawn/execFile/transport 路径，确认是否绕过 adapter。测试“spawn adapter 只改道”；F + N。 |
| H2 / 41d53ce；0.0.37 增量 | createDeferredChild 保留早到 PAT stdin、流/事件/kill/abort；exitCode/signalCode 与标准 ChildProcess 语义衔接。 | 延迟 Host handle 前写 stdin 仍送达；新 HiddenStdioClientTransport close 真正 kill 活跃子进程，不因 undefined 判断已结束；重复 close 不重杀，exit/close 同步状态，启动失败合理结束。测试“deferred child”“新版 Runtime transport”；F，真实 Host 生命周期 D。 |
| H3 / 14cfc58 | maker-mcp.cjs stdio 按属性能力替换或原地代理。 | 可配置/不可配置 stdin、stdout 和预缓存 initialize 组合；先抽干旧字节再路由，避免递归；真实 Runtime 完成 initialize、roots-aware tools/list、资源读取。已有 N 测试不替代 Windows 正式/Beta Cindy。 |
| H4 / df08857→5305627 | logs watch 用系统 node，Maker 管 PID/生命周期；不再有 Cindy watcher 空闲 controller。 | 系统 Node 可用/不可用各测；缺失只报错一次，不启动 Cindy.exe，不回退 spawnEntry；主 proxy 不受影响。不能称为“关闭日志”。F 后必须真实构建/日志获取/退出 D，日志 watcher 与本地 preview supervisor 分开验收。 |
| H5 / 41d53ce、52f15ee | mcp-root-router.cjs 仅活动 list 的可信绝对 workdir；其它反向 RPC 拒绝；列表串行、超时丢旧响应并重建。 | 两工作区并发不串线；超时中活动/排队请求都结束；陈旧回包不污染新 worker。Windows URI 用 pathToFileURL，不能硬写 POSIX。测试“root router”“roots-aware”；F/N。 |
| H6 / 41d53ce | isMakerCliOutputComplete + account.runMaker：最终 JSON 才回收；进度心跳、14 分钟限时、每输出流 2 MiB 上限。 | 新 CLI login/pat/apps/doctor/init JSON 结构逐命令对照；进度不能误当 done，成功后不能被 ParentPort 挂住，超限/超时 kill。测试“最终 JSON”；模拟不能证明真实登录结束，应 D。 |

## 账号、目录和设置任务

| ID / 来源 | 最终保护与定位 | 每次升级的具体检查与验收 |
| --- | --- | --- |
| A1 / 41d53ce、9029599 | account.cjs pat set --pat-stdin --json；Maker 校验/保存；环境变量、新旧文件仅用于存在/掩码兼容；main.js publicAccountResult 脱敏。 | PAT 不进 argv/日志/模型结果/新增 Cindy KV 或 Secret；页面输入用后清空；网络失败状态 unknown，不冒充已退出。测试“账号工具不向模型返回 PAT”；实际 PAT 保存/切换 D，不能无证据删旧路径兼容。 |
| A2 / 3b8f23d、9029599、6e4affe、8475e33 | isMissingLogin/projectSyncFailure/settingsErrorCode 与 settings.js syncFailureText。 | 原 missing/expired/401/403 格式；目录、Git（两个 code）、Python、网络逐类；错误可行动且脱敏。若新包错误结构改变，补样例，不扩大自动重试。F/S 与实际联网失败边界分开。 |
| A3 / ddcc0b7→675d2c3→e58a241→d5132e4→9cbebaa | 稳定目录名及 ensureTargetAvailable；空目录或 config project_id + Git origin 同项目，环境匹配，元数据无 symlink。 | 同名不同 ID、跨批次、Windows 名称；错项目、缺 origin、缺 .git/config、生产/RND 不匹配、symlink/非目录都拒绝；URL auth 不泄露。测试“目录名跨批次”“目标只允许”；不能恢复早期任意非空目录重试。 |
| A4 / 41d53ce、675d2c3、9029599 | main.js settingsRequests 按 reqId 去重；account.withMutation、最多五个去重项目、逐项结果、--skip-mcp-install。 | 同 reqId 重发不重复登录/克隆；并行账号变更互斥；单项目失败保留其它项目结果；已有 app 与新建参数互斥；不改外部 Agent MCP 注册。测试“重发同一 reqId”，批量真实 init/克隆需用户目标与 D。 |

## 工具行为、素材策略与 UI

| ID / 来源 | 最终保护与定位 | 每次升级的具体检查与验收 |
| --- | --- | --- |
| T1 / 41d53ce、df08857、7280910 | requireLocalContext/requireWritableContext；宿主 session_context workdir 覆盖工具 target_dir，远程工作区拒绝。 | status/指南只读可用，init/build/动态工具/console 写能力只读拒绝；query/get 也可能下载写文件，不能按名字放行。设置页用户选目录流程是独立授权入口，不强行套 Agent workdir。F/S。 |
| T2 / 9029599、891868e、7465ceb | 按工作区合并 initializeMakerIdentity；只对明确缺身份且状态缺省/not_executed 做一次二维码和一次原调用。 | executed/unknown 不恢复；初次调用、二维码、重试后的缺身份/unknown 分别测；没有构建信息、屏幕方向或游戏类型选择就停止，不能自动构建。缺省兼容仅是既有身份恢复契约，不可扩展到通用网络/MAC 重放。F。 |
| T3 / 9029599、891868e、d0b428c、7465ceb、431213e、d54ef28 | makerExecutionDetails/sanitizeMakerFailure/sendToolResult 贯通状态与脱敏，unknown 先核对远端；精确积分不足。 | structuredContent/remote_structured_content、JSON text、remote_result/error_details、固定文本三态；catch/初始化/重试/列表拦截都查最终结果。凭证/本地路径/stack 去掉不应丢执行态。普通错误不可冒充 INSUFFICIENT_BALANCE；Art 替代需用户确认。F + 宿主模拟，未覆盖分支明确列出。 |
| T4 / 2407dd5、0a05682、891868e、bdc6bdd | status detail/skip_remote_sync 与 normalizeMakerPluginGuidance；固定工具别名和目录快照。 | PAT+auth 同时缺失先匹配；Python/LSP 未就绪、已就绪、建议升级三态；不要提示用独立 CLI/npm 覆盖随包 Runtime。状态摘要仍有 /tracking，目录快照不是实时可用性保证；实际工具名/schema 对照新包，固定内部名不能绕开 maker_build。F/S/N。 |
| T5 / 9aa6527、a887ccc | maker_ads_guide 固定 resources/read；Maker 专属广告召回。 | 真实新包资源存在且含当前广告 API 指引；只读会话可调用，不改项目；不要因为泛平台广告问题就召回 Maker。F/N/S。 |
| T6 / 577da80 | Runtime build 前安全快进：仅本地 main 落后；异常在 commit/push 前停止。 | behind 可 ff-only；分叉、非 main、状态未知、覆盖未提交修改不提交/推送；push 失败不 build，push 后 build 失败不能说代码未提交。测试“仅在落后远端时快进”；F，真实仓库副作用测试需隔离目标和授权。 |
| M1 / 3e0dffb、a12cdc5 | main.js callMakerTool 三类默认开，开关只拦截后续对应请求、不隐藏目录。 | 生图 generate_image/batch_generate_images/edit_image；视频 create_video_task；音频 text_to_music/text_to_sound_effect/batch_sound_effects/text_to_dialogue/audition_voices_for_character/confirm_character_voice；query_video_task 不拦。新版本新增工具逐个分类，不默认所有素材工具都覆盖。F。 |
| M2 / 6602807、431213e、a301b67、a12cdc5 | 设置读取失败/损坏/关闭均 fail-closed，最终结构化 not_executed；身份恢复重试再次读开关。 | 三类各测不发送、零 call；在二维码与重试之间关闭开关，不再发送原工具；不自动转其它插件、不取消已提交任务。测试“身份恢复期间关闭”“设置异常”；F。 |
| M3 / 3e0dffb | settings.js 加载期间禁用；读改写仅更新目标键并保留其他偏好；保存失败恢复显示且禁用要求核对。 | 旧 image 偏好保留，新类别默认开，损坏/HTTP 错误不能放行；互斥保存，不假报已保存。模拟页面测试 + 设置页 D；不要重构为跨进程共享策略。 |
| U1 / 41d53ce、df08857 | previewUrlFromResult 校验官方 https maker_url、/app/、localDev=1；加 hide_chat，sessionId 随宿主预览传递，返回可点击 markdown。 | 不打开伪造 host/任意 URL，不调系统浏览器；预览打开失败保留构建成功，不能重新构建。远端网页预览不等于 UrhoX 本地原生窗口；F/D。 |
| U2 / e351b96、4235938、e5e1396、6e4affe、8475e33、a887ccc、20b0b06 | Host 四语言与英文回退；Manual 不再全局 Skill；manifest/locales/settings/manual 行为一致。 | /app-context 超时不阻塞设置，映射错误码；明确 Maker 才召回，插件源码维护不走游戏工具。依 docs/localization.md 回退契约，不增加额外翻译要求。S/页面模拟/D。 |
| U3 / 7f00a60 | Manual UrhoX 沙箱库限制与 TimeStep 计时指引。 | 升级文档/Manual 不丢禁用库提示；本地原生预览需验证画面、交互、联网、日志、刷新、退出；窗口出现不是通过。真实游戏 D，未运行则列待验证。 |
| U4 / c58a81a、8e9defb | node/console.cjs 固定系统 node + execFile，shell:false/windowsHide，loopback URL 严格白名单；页面关闭不停止服务。 | ENOENT/EACCES 未启动→not_executed，其余无法确认→unknown；预览打不开不重复启动。拒绝 userinfo/其他 host/非根路径/hash/额外 query；settings 与 Agent 两入口都测。不自动构建、提交、装游戏环境；控制台手动操作不宣称受 Agent 开关限制。F/N/D。 |

## 包、发布与来源

| ID / 来源 | 最终保护与定位 | 每次升级的具体检查与验收 |
| --- | --- | --- |
| P1 / b662445、a887ccc、3e0dffb、98c362b；各版本提交 | ghost.json、provisioning、包契约；schema v3、minCindyVersion 0.1.64 起的现有边界、手动安装 audience。 | 插件版本高于 main；不恢复 slots/全局 Skill/自动分发；实际需求决定新最低宿主版本，降低需维护者审查。四门禁在本仓运行，不 checkout 私有仓绕过。打包安装需稳定/Beta Cindy，不能用 Dev 替代。 |
| P2 / 36cac63、52f15ee、8e9defb | 完整第三方许可证与最终 .cindy 法律文件。 | 比新旧包新增/替换依赖及嵌入 wasm/编码 UI 资源，对照官方来源；法律文本不是只列包名。保留 vendor/LICENSE 与根 LICENSE/NOTICE 等发布约定；核对实际包大小/路径/内容。0.0.37 的新依赖不能沿用 0.0.34 notices 宣称已齐。 |
| P3 / c58a81a、8e9defb | .github/scripts/sync-maker-runtime.mjs + 逐版本 recipe。 | npm 身份/integrity、原 bundle hash、每补丁 anchor count、patched hash、完整 vendorHashes、语法检查；tar 路径/链接/特殊文件检查先于解包。锚点错误/额外或缺文件拒绝；staging 成功才替换，失败保留/回滚原 vendor。现有升级测试含离线反推原包验证，不替代本次实际官方下载完整性。 |

## 0.0.37 前序验证记录（2026-10-19，插件 2.1.16 历史快照）

当前 PR 包版本为 2.1.19，包含本地验证、大报告摘要、证据 Git 忽略检查和结构化路径清理。
以下测试与实机缺口属于前序记录，不代表当前包已完成实机验收。

- 当时工作树插件 2.1.16 / Runtime 0.0.37；八项 recipe 补丁加 H2 facade 修改。官方 npm tarball 与 recipe integrity 对应，源 tag maker-v0.0.37/b3570c1 仅辅助核对；本地源码 package.json 的 dev 版本不是发布证据。
- 本轮前序已运行 Maker + upgrade 66 项通过；六套门禁共 93 项，86 通过、7 失败。失败涉及 Windows localization 路径及 publish-workflows 的 WSL/bash/jq 环境，不据此宣布完整门禁已通过，也不修改无关测试。
- 系统 Node 隔离 HOME console 启动/health/HTML/关闭已做；无模型设置入口、server-only 配置、写设置 API 403、托管更新禁用已核对。未使用真实 PAT，也未调用付费生成。
- 新增编码 UI 资源已与上游 tag 对照；没有为审查而执行编码内容。许可证已更新；实际打包不等于已安装。
- **仍需 D**：正式/Beta Cindy 安装当前包；真实 PAT 切换与受限账号；真实克隆/构建/付费调用故障恢复；生产日志 watcher；Console 跨会话停服所有权；UrhoX 原生画面与交互。静态或模拟通过不消除这些缺口。
- **历史证据缺口**：a3d295d 的完整 hash/原 diff 未获取，见 history.md。若取回后有新保护，新增矩阵条目并补适配，不将其默认为 V1/V6 的重复。
