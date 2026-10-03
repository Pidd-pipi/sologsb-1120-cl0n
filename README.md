# sologsb-1120 古钟表维修工序档案（gbclockrepair）

面向钟表修复师的工序档案台：为一台古董钟表建档，记录机芯型号、零件缺失与配换、拆解顺序、清洗润滑点位，以及修复后的走时测试数据。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21820**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
npm run verify   # 复核流程 + v2→v3 迁移的逻辑验证（fake-indexeddb）
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1120/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    ├── scripts/                # 复核流程与迁移的逻辑验证（npm run verify）
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{clock,part,step,test,review}.ts
        ├── stores/{clock,part,step}Store.ts
        ├── components/common/{StepSequence,RateChart,ClockCard,StateBadge,ReviewDialog}.vue
        ├── hooks/{useClockSearch,useRepairProgress}.ts
        ├── pages/{ClockList,ClockDetail,StepForm,PartList,TestView}.vue
        └── utils/{db,review,reviewFlow,crossTab,timeCalc,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/clocks` | 钟表台账：按种类/机芯/品相/年代区间筛选，按修复状态分栏 | Clock |
| `/clocks/:id` | 钟表详情：左侧机芯信息，右侧工序流与走时测试记录，可切零件清单 | Clock、RepairStep、TimekeepingTest、MovementPart |
| `/steps/new` | 新建维修工序：选步骤类型后动态出清洗液/油脂/力矩字段，顺序号冲突即报错 | RepairStep、MovementPart |
| `/parts` | 零件与配换清单：按磨损状态分组，标出待修配条目与来源批号 | MovementPart |
| `/tests/:clockId` | 走时测试录入与多方位均值计算，生成走时单文本 | TimekeepingTest |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 四张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3 迁移：零件补 `revision`（初始 1）与 `updatedAt`；工序/走时测试补 `reviewState='valid'`，并按当前零件版本补齐 `partBaseline` 复核基准，老记录升级后继续可用。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序与 1 次走时测试。

## 复核基准（零件 → 工序/走时测试）

零件的处理决定、关键尺寸或来源批号变动后，按旧信息做的工序和走时测试必须失效重算。零件清单、钟表详情、走时测试三处共用同一套复核基准：

- **零件版本**：零件任何字段变动 `revision` +1；工序按 `partIds` 记录关联零件版本快照，走时测试记录本钟表全部零件的版本快照（`partBaseline`）。
- **失效重算**：零件增删改后，关联工序与本钟表走时测试在同一事务内标记「待复核」；复核时工序剔除已删除的关联零件、走时测试按方位读数重算均值与结论，然后按当前零件版本重立基准恢复「有效」。
- **复核冲突**：复核对话框打开时快照所见零件版本，确认时若零件又变过（如另一标签页刚保存），提示冲突并保持「待复核」，载入最新版本后需重新核对。
- **多标签乐观锁**：编辑零件以打开时的 `revision` 为基准，保存时库中版本已变则拒绝覆盖（后保存页面不得覆盖先提交的版本），提示「载入最新版本」且本页未提交内容保留；各标签页通过 BroadcastChannel 互相刷新缓存。
- **失败恢复**：失效/复核流程先快照原记录，写库失败即恢复原记录并提示重试。
- **同一结果展示**：台账完成状态分栏、详情页进度、走时单与历史记录只统计复核后「有效」的工序与走时测试；有待复核记录的钟表不会停在「已完成」。

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **零件版本管理**：零件清单可编辑/删除零件，行内显示版本号 `rN`；变动即触发关联工序与走时测试失效。
- **复核入口**：钟表详情（工序顺序、走时测试）与走时测试页历史记录均提供「复核」按钮，弹出基准对照对话框。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本（含零件基准摘要行），可复制或下载 txt。
