# 陶片拼接推演工作台（Sherd Stitch Workbench）

供考古工作室在浏览器中推演陶片（陶片/陶片残片）拼合关系的 Web 工作台。

- **Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器 Canvas**，无前端构建步骤。
- 上传陶片照片、为每片标记**毫米比例尺**（图上像素长度 ↔ 真实毫米）。
- 以“接缝”记录两片之间的**旋转角 θ、平移 (tx, ty)**（单位毫米）与**接缝说明**。
- 画布按**已采纳接缝**自动拼出各**连通组**，显示每片位置及其所依据的**接缝链**；未连通陶片单独成卡显示。
- 新接缝形成环时，若推算位置与现有布局的偏差超过方案的**毫米容差**，**拒绝采纳**、给出**冲突接缝链**与偏差数值，**原布局保持不变**。
- **修订已采纳接缝**：可对任意一条接缝修改**旋转角 θ、毫米平移 (tx, ty) 与说明**（接缝身份与采纳排序不变）。提交前先做**只读预览**——按原接缝身份及排序重算各陶片位姿与**每一个闭合环**残差、逐条列出**超差接缝的冲突链**，预览**不改动方案**；确认时服务器基于当前版本**原子地重新校验全部闭合环**，任一残差超差即拒绝（422，接缝/版本/布局均不变），版本落后返回 409，成功后接缝 ID 与排序不变、版本只递增一次、读取布局与预览一致。
- **批量试拼候选接缝（本轮新增）**：把若干条候选接缝作为**一批**按顺序填写（每条：两端陶片、旋转角 θ、毫米平移、说明），先做**只读试算**——**已有接缝优先**，候选按填写顺序参与布局，工作台给出整批加入后的**连通组、陶片位姿及每个闭合环残差**，超差时指出**候选序号、偏差与冲突链**；试算不改接缝和版本。确认必须使用**同一批内容**及**试算所基于的方案版本**，服务器在**单事务**内重新校验全部闭合环，通过才**依序采纳且版本只增加一次**，否则**整批不生效**（422）；方案版本已变化返回 **409** 并要求重新试算。陶片不属于本方案、未标比例尺、接缝连接同一片或参数非法时整批拒绝（400，逐条指出候选序号）。
- **撤销接缝即整体重算**连通组与位姿（布局从不持久化），不会沿用失效布局。
- **多人编辑乐观锁**：每个写请求须带 `Base-Version`；版本落后时返回 `409` 并在网页弹窗提示，绝不静默覆盖；页面还会每 10 秒轮询版本并提示他人更新。
- **方案移交包（本轮新增）**：把整个方案导出为**自包含 ZIP**（方案名称、毫米容差、陶片照片及毫米比例尺、按采纳顺序排列的接缝、每张照片的 SHA-256 校验摘要）；导出在单个读事务内取**同一版本快照**，导出期间即使方案被编辑，包内数据仍一致。另一台工作台导入 ZIP 时创建**独立新方案**、**重分配本地 ID** 并按顺序重新关联接缝与照片，**布局（连通组/位姿）与全部闭合环结果与源方案等价**。导入前逐项检查**清单、参数、照片摘要、缺失/重复/多余文件、越界路径、照片魔数与全部闭合环是否超容差**；任何损坏或不合法都**整包拒绝**（400/422），不留下方案或孤儿照片。网页首页可导入、方案页可下载，同时提供可调用的 HTTP API。

## 运行方式

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build -d
```

容器启动时即安装依赖、打开/创建 SQLite 并执行首次建表（`CREATE TABLE IF NOT EXISTS`），无需手工初始化。

浏览器访问：

```
http://localhost:8080
```

停止：

```bash
docker compose down          # 保留数据（命名卷 sherd-data）
docker compose down -v       # 同时删除数据库与上传图片
```

### 方式二：本机 Node.js

要求 Node.js ≥ 20。

```bash
npm install
npm start
```

默认访问 http://localhost:8080 ，数据库与图片位于 `./data/`（首次启动自动创建并建表）。

### 冒烟测试

```bash
npm test        # 即 node test/smoke.js
```

覆盖：建表就绪 → 建方案/上传/比例尺 → 接缝拼组与位姿传播 → 撤销断组重算 → 成环残差为 0 采纳 → 成环超差 422 拒绝且布局不变 → 过期版本 409 / 缺版本 428 → 接缝修订预览（只读、不改版本/接缝、给出超差冲突链）→ 修订确认 422 原子拒绝 / 容差内成功（ID 与排序不变、版本 +1、读取布局与预览一致）/ 409 / 428 / 400 / 404 → 修订成环接缝与仅改说明 → **批量试拼**：只读试算（既有接缝优先、候选按序为生成树/成环、位姿/残差/候选序号+冲突链、不改版本）→ 前置校验 400（同片/参数非法/陶片不属于方案/空批）→ 超差批 422 整批回滚 → 指纹不符 400 / 缺版本 428 / 版本变化 409 要求重试算 → 成功依序采纳且版本只 +1、读取布局与试算一致 → 批内桥接两个连通组并成环 → **方案移交包**：导出同一版本快照 ZIP（清单/照片/摘要、未标定陶片、快照版本响应头）→ 导入创建独立新方案且本地 ID 重分配、接缝照片重新关联、位姿/残差/未连通片等价 → 空方案导出导入 → 各类损坏/非法包整包拒绝（非 ZIP、截断、缺/重复/多余文件、越界路径、照片 SHA-256 与魔数、清单参数、接缝引用/同片/引用未标定片、format、seq 不连续、CRC32）→ 闭合环超差 422（序号/偏差/冲突链）→ 非 .zip / 错字段 400 → 拒绝后无方案、无孤儿照片。

## 使用说明

1. 首页**新建方案**，设定“闭合环毫米容差”（默认 2 mm，可随时在方案设置中修改）。
2. 进入方案，左侧**上传陶片照片**（图片在浏览器端自动压缩到最长边 2000px）。
3. 选中陶片 → **标记比例尺**：在照片上拖出一段对应已知长度的线段并填写毫米数（如 10 mm）。未标比例尺的陶片以占位尺寸单独显示，且不能参与接缝。
4. 点左侧 **新建接缝**：选择 A 片（参考、固定）与 B 片（移动对齐），在对齐窗口中
   拖动 B、用滚轮/输入框旋转 B，使断口吻合，并填写接缝说明；采纳即记录
   `p_B = R(θ)·p_A + (tx, ty)`（局部毫米坐标映射）。
5. 画布中：
   - **实线棕色**接缝为生成树接缝，决定布局；**橙色虚线**为成环接缝，仅用于闭合校验。
   - 陶片按毫米真实尺寸、按世界位姿绘制；右下角有毫米比例尺。
   - 点击陶片，右栏显示其毫米尺寸、世界位姿与“位置依据”接缝链（根片起的 `#接缝 → …`）。
   - 点击接缝编号可查看 θ/平移/说明、闭合残差并**撤销**。
6. 当新接缝形成环且闭合偏差超过容差时，会弹出拒绝框：显示偏差毫米数、角度差、
   冲突链（途经陶片与接缝及其说明），布局不发生任何变化。
7. 撤销任意接缝后，连通组立即重新划分、位姿由剩余接缝重新推导；原先连成一片的
   陶片可能分裂为多组或变为未连通片。
8. **修订已采纳接缝**：在右栏“接缝”列表中点击某条接缝旁的 **修订**，修改旋转角 /
   毫米平移 / 说明（接缝 `#id` 与两端陶片固定、采纳排序不变）。弹窗会在停笔约 0.25 秒后
   **自动预览**（也可点“立即预览”）：
   - 画布按**原接缝身份与排序**重绘全部陶片位姿（被修订接缝两端用蓝框、`#id ✎` 标出）；
   - 下方列出**每个闭合环残差**；超差接缝以红色标出并给出**冲突链**（生成树上的陶片/接缝路径 + 闭合接缝）；
   - 预览始终为只读，**不会改动方案**；任一闭合环超差时“确认修订”禁用。
   - 点“确认修订”时服务器基于当前方案版本**重新原子校验全部闭合环**：全部在容差内才写入，
     接缝 ID 与排序不变、版本只 +1，随后画布与预览完全一致；若期间他人已改方案则按
     `Base-Version` 约定返回 409（不会套用旧预览）；若重算仍超差则 422 且原接缝、版本、布局均不变。
9. **批量试拼候选接缝**：点左侧 **批量试拼**，在弹窗中按顺序逐条添加候选接缝
   （两端陶片 A→B、θ/tx/ty、说明，可任意增删行）。点 **试算整批**（停笔也会自动试算）：
   - 画布按“**既有接缝优先、候选按填写顺序加入**”重绘：候选生成树接缝为**蓝色实线**、
     候选成环接缝为**绿色虚线**（标签为“候1、候2…”），候选涉及的陶片加蓝框；既有接缝配色不变；
   - 下方给出每条候选的角色（**生成树接缝 / 成环接缝**）与**每个闭合环残差**；
     超差时以红色标出并逐条给出**候选序号、偏差毫米数、角度差与冲突链**（树上的陶片/接缝路径 + 闭合候选）；
   - 试算始终只读，**不改动接缝与版本**；任一闭合环超差时“确认采纳整批”禁用。
   - 点 **确认采纳整批** 时，浏览器回传**同一批内容指纹**与**试算所基于的版本号**，
     服务器在**单事务**内重新读取并复核全部闭合环：通过才按填写顺序逐条采纳、
     **版本只增加一次**，随后画布与试算完全一致；若期间他人已改方案则返回 409，
     弹窗关闭并提示**重新试算**；重算仍超差则 422、整批不生效，弹窗会基于服务器当前状态重新试算。
10. **移交方案给另一台工作台**：
    - **导出**：方案页右上角点 **📦 导出方案包**，浏览器下载 `<方案名>.zip`。
      导出是只读操作（不需要 `Base-Version`、不推进版本）；服务器在**单个读事务内**
      读取方案/陶片/接缝行并读出全部照片字节——**导出期间即使方案被他人编辑，
      包内数据仍全部来自同一版本快照**（响应头 `X-Snapshot-Version` 标明该版本）。
    - **导入**：在**首页**点 **📦 导入方案包**，选择 `.zip`。服务器先在内存中做
      **整包校验**（见下），通过后才写入；成功后跳转到**新建的独立方案**——
      它有自己的本地 ID（陶片按包内顺序、接缝按采纳顺序重新编号），与源方案、
      与此前任何导入副本都互不影响，**布局与闭合环结果与源方案等价**。
    - **整包拒绝**：不是合法 ZIP、清单缺失/损坏/参数非法、照片缺失或 SHA-256
      不符、文件重复/多余、路径越界（含 `..`、绝对路径、反斜杠、盘符）、
      照片内容与扩展名不符，或**任一闭合环残差超过包内毫米容差**，都会被整包拒绝，
      网页弹窗逐条列出问题；此时**不会创建方案，也不会留下任何照片文件**。

## 可配置项

均通过环境变量配置（见 `docker-compose.yml` 的 `environment`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（容器内）。改宿主机访问端口请改 compose 的 `ports` 左侧，如 `"9090:8080"` |
| `DATA_DIR` | `./data`（本机）/ `/data`（容器） | 数据目录，存放 SQLite 与上传图片 |
| `DB_FILE` | `$DATA_DIR/workbench.db` | SQLite 数据库文件路径 |
| `UPLOAD_DIR` | `$DATA_DIR/uploads` | 陶片图片保存目录 |
| `MAX_UPLOAD_MB` | `20` | 单张照片上传大小上限（MB） |
| `MAX_PACKAGE_MB` | `100` | 导入方案包（.zip）大小上限（MB） |

方案级的**毫米容差**在网页“方案设置”中按方案独立配置，不是环境变量。

## 网页访问端口

- 默认：**http://localhost:8080**
- Docker 下在 `docker-compose.yml` 修改端口映射；本机运行用 `PORT=9090 npm start`。

## 批量试拼 HTTP API（可调用）

把**一批**候选接缝（按填写顺序）先试算、后确认。试算只读；确认必须回传**同一批内容指纹**
（`batch_fingerprint`）与**试算所基于的方案版本**（`base_version` 与 `Base-Version` 头）。
每条候选字段与单条接缝一致：`from_id` / `to_id`（不同两片、均属本方案且已标比例尺）、
`theta_deg`（-360~360）、`tx` / `ty`（毫米，-100000~100000）、`join_note`（≤2000 字，可选）；
一批最多 100 条。

### 第一步：试算（只读，不需要 `Base-Version`，不改动方案/版本）

```
POST /api/projects/{id}/seams/batch-preview
Content-Type: application/json

{
  "candidates": [
    { "from_id": 2, "to_id": 3, "theta_deg": 0, "tx": -10, "ty": 0, "join_note": "候选 2-3" },
    { "from_id": 3, "to_id": 4, "theta_deg": 0, "tx": -10, "ty": 0, "join_note": "候选 3-4" },
    { "from_id": 1, "to_id": 4, "theta_deg": 0, "tx": -30, "ty": 0, "join_note": "闭合复核 1-4" }
  ]
}
```

返回体与 `GET /api/projects/{id}` 同构（`project` / `sherds` / `seams` / `layout`），另附：

- `batch_trial: true`、`preview_only: true`；
- `base_version`：试算所基于的当前方案版本（确认时原样回传）；
- `batch_fingerprint`：该批内容指纹（确认时原样回传）；
- `seams[]`：既有接缝用真实 `id`；候选为**虚拟接缝**，`id` 为 `null`、
  `virtual_seam_id` 为负数（-1、-2…，按填写顺序）、`candidate_index` 从 1 起；
- `candidate_results[]`：每条候选的布局角色——`role: "tree"`（生成树接缝，决定布局）
  或 `"cycle"`（成环接缝，仅做闭合校验）；
- `layout`：整批加入后的连通组、陶片位姿与**每个闭合环**残差（`residuals`）；
- `violations[]`：超差闭合环，元素含 `candidate_index`（超差候选序号，1 起）、
  `deviation_mm`、`rotation_deg`、`tolerance_mm` 与 `conflict_chain`
  （`sherds` 陶片路径、`seams` 树路径——其中候选带 `candidate_index`、既有接缝带真实 `id`、
  `closing_seam` 闭合候选）。无超差时为空数组。
- `400`：候选非法时 `error.reason = "batch_invalid_candidates"`，
  `error.errors[]` 按候选序号逐条给出原因（陶片不属于本方案、未标比例尺、连接同一片、参数非法等），整批不予试算。

### 第二步：确认（单事务，必须带试算时的 `Base-Version`）

```
POST /api/projects/{id}/seams/batch-commit
Base-Version: 9
Content-Type: application/json

{
  "candidates": [ …与试算完全相同的一批… ],
  "base_version": 9,
  "batch_fingerprint": "<上一步返回的指纹>"
}
```

- `200`：服务器在**单事务**内基于该版本重新读取并全量重算、复核**全部闭合环**；
  通过才按填写顺序**依序插入**全部候选并把版本**只 +1**；响应即 `GET /api/projects/{id}`
  标准负载，`layout` 与试算一致（候选接缝此时已取得连续的真实 id）。
- `422`：任一闭合环残差超容差。`error.reason = "batch_cycle_tolerance_exceeded"`，
  `error.violations[]` 给出每条超差的**候选序号**与冲突链；**整批不生效**，接缝、版本、布局均不变。
- `409`：`Base-Version`/`base_version` 与当前版本不一致（试算后方案被他人修改），
  `error.reason = "batch_version_conflict"`，返回 `current_version` / `your_version`；
  **必须重新试算后再确认**，不套用旧试算结果。
- `400`：缺少/错误 `batch_fingerprint`（`batch_content_mismatch`，批内容与试算不一致），
  或候选本身非法（同上）；`428`：缺少 `Base-Version`。以上均不改变任何状态。

### curl 示例

```bash
# 1) 试算（只读，保存指纹与版本）
curl -s -X POST http://localhost:8080/api/projects/1/seams/batch-preview \
  -H 'Content-Type: application/json' \
  -d '{"candidates":[
    {"from_id":2,"to_id":3,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 2-3"},
    {"from_id":3,"to_id":4,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 3-4"},
    {"from_id":1,"to_id":4,"theta_deg":0,"tx":-30,"ty":0,"join_note":"闭合 1-4"}
  ]}'

# 2) 用试算返回的 base_version / batch_fingerprint，在同一批内容上确认
curl -s -X POST http://localhost:8080/api/projects/1/seams/batch-commit \
  -H 'Base-Version: 9' -H 'Content-Type: application/json' \
  -d '{"candidates":[
    {"from_id":2,"to_id":3,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 2-3"},
    {"from_id":3,"to_id":4,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 3-4"},
    {"from_id":1,"to_id":4,"theta_deg":0,"tx":-30,"ty":0,"join_note":"闭合 1-4"}
  ],"base_version":9,"batch_fingerprint":"<preview 返回值>"}'
```

## 接缝修订 HTTP API（可调用）

修订一条**已采纳接缝**采用“先预览、后确认”两步。接缝身份（`from_id` / `to_id`）与采纳排序（接缝 `id`）不可修改；
可改字段为 `theta_deg`（°，-360~360）、`tx`、`ty`（毫米，-100000~100000）、`join_note`（≤2000 字，可选；省略时沿用原说明）。

### 第一步：预览（只读，不需要 `Base-Version`，不改动方案）

```
POST /api/seams/{seamId}/revision-preview
Content-Type: application/json

{ "theta_deg": 0, "tx": -11, "ty": 0, "join_note": "口沿 A-B 微调" }
```

返回体与 `GET /api/projects/{id}` 同构（`project` / `sherds` / `seams` / `layout`），但其中
`seams` 是“按原 id 与排序替换该接缝参数后”的假设集合，`layout` 是相应重算结果，另附：

- `base_version`：当前方案版本（确认时应原样回传）；
- `revised_seam_id`：被修订接缝 id；
- `preview_only: true`；
- `violations[]`：**每一个**超差闭合环，元素含 `seam_id`（超差的闭合接缝）、`deviation_mm`、
  `rotation_deg`、`tolerance_mm` 与 `conflict_chain`（`sherds` 陶片路径、`seams` 生成树路径及说明、
  `closing_seam` 闭合接缝）。无超差时为空数组。

### 第二步：确认（必须带当前 `Base-Version`）

```
PATCH /api/seams/{seamId}
Base-Version: 11
Content-Type: application/json

{ "theta_deg": 0, "tx": -11, "ty": 0, "join_note": "口沿 A-B 微调" }
```

- `200`：成功。服务器在**单事务**内基于该版本重新读取并全量重算、复核全部闭合环，通过才更新该接缝并把
  版本**只 +1**；响应即 `GET /api/projects/{id}` 标准负载，`layout` 与上一步预览一致，接缝 ID/排序不变。
- `422`：任一闭合环残差超方案毫米容差。`error.reason = "revision_cycle_tolerance_exceeded"`，
  `error.violations[]` 给出每条超差接缝与冲突链；**原接缝、版本与布局均不变**（事务回滚）。
- `409`：`Base-Version` 与当前版本不一致（方案已被他人修改），返回 `current_version` / `your_version`；
  本次拒绝，**不得套用旧预览**，应重新拉取方案与预览后再确认。
- `428`：缺少 `Base-Version`；`400`：参数非法；`404`：接缝不存在。以上均不改变任何状态。

### curl 示例

```bash
# 1) 预览（只读）
curl -s -X POST http://localhost:8080/api/seams/1/revision-preview \
  -H 'Content-Type: application/json' \
  -d '{"theta_deg":0,"tx":-11,"ty":0,"join_note":"口沿 A-B 微调"}'

# 2) 基于当前版本确认（假设当前版本为 11）
curl -s -X PATCH http://localhost:8080/api/seams/1 \
  -H 'Base-Version: 11' -H 'Content-Type: application/json' \
  -d '{"theta_deg":0,"tx":-11,"ty":0,"join_note":"口沿 A-B 微调"}'
```

既有单条接缝接口与返回契约保持不变：`POST /api/projects/{id}/seams`（采纳/成环拒绝）、
`DELETE /api/seams/{id}`（撤销）、`GET /api/projects/{id}`（读取现算布局）。
批量接口 `POST /api/projects/{id}/seams/batch-preview`（只读试算）与
`POST /api/projects/{id}/seams/batch-commit`（单事务确认），均不改变上述既有约定。

## 方案移交 HTTP API（可调用）：导出 / 导入 ZIP

自包含 ZIP 包，可直接交给另一台工作台（或同一台机器）导入。导出只读、不需要
`Base-Version`；导入创建**独立新方案**，也不需要 `Base-Version`（它不修改任何
既有方案）。

### 包结构

```
project.zip
├── manifest.json                 # 清单（DEFLATE 压缩）
└── photos/
    ├── sherd-0001.jpg            # 陶片照片（STORED 原样保存）
    ├── sherd-0002.png
    └── …
```

`manifest.json`：

- `format`：固定 `"sherd-stitch-workbench"`；`format_version`：当前 `1`。
- `exported_at`：导出时间（UTC ISO 字符串）。
- `source`：源方案信息 `{ project_id, name, tolerance_mm, version }`（导出快照版本，仅作记录）。
- `project`：`{ name, tolerance_mm }`——新方案将使用的名称与毫米容差。
- `sherds[]`：按源本地 id 升序编号 `seq`（从 1 起连续），每条含
  `label` / `note`、`photo`（包内相对路径）、`photo_sha256`（小写 64 位十六进制）、
  `photo_bytes`、`img_w` / `img_h`、`scale_px` / `scale_mm`（未标比例尺时两者均为 `null`）。
- `seams[]`：**按采纳顺序**排列，`seq` 即从 1 起的位置；每条含
  `from_seq` / `to_seq`（引用陶片 `seq`，不引用源本地 id）、
  `theta_deg` / `tx` / `ty` / `join_note`。

### 导出（只读，同一版本快照）

```
GET /api/projects/{id}/export
```

- `200`：`Content-Type: application/zip`、`Content-Disposition: attachment`；
  响应头 `X-Snapshot-Version` 为导出快照版本、`X-Snapshot-Project-Id` 为源方案 id。
  行数据与照片字节全部在同一个读事务内取得；导出期间方案被编辑不影响本包一致性。
- `404`：方案不存在。

### 导入（创建独立新方案）

```
POST /api/projects/import
Content-Type: multipart/form-data
```

表单字段：

- `package`：方案包文件（文件名需以 `.zip` 结尾）。

服务器在写库前完成**全部整包校验**：ZIP 结构与 CRC32、清单格式/字段/参数范围、
照片 SHA-256 与字节数、缺失/重复/多余文件、越界或非法路径（仅允许
`manifest.json` 与 `photos/` 下单段安全文件名）、照片魔数（JPG/PNG/WebP）
与扩展名一致、接缝引用合法（端点存在、不相同、均已标比例尺）、
陶片/接缝 `seq` 从 1 起连续；随后用导入后的本地 id 以同一布局引擎复核
**全部闭合环**。

- `201`：成功创建独立新方案，响应体即 `GET /api/projects/{newId}` 标准负载，另附
  `imported: true` 与 `source`（源方案记录，可为 null）。陶片按 `seq` 顺序取得
  连续的新本地 id；接缝按采纳顺序插入，两端重映射到新 id；新版本从 `v1` 开始。
  布局（连通组、每片世界位姿、未连通陶片）与全部闭合环残差与源方案等价。
- `400`：包损坏或不合法。`error.reason` 为 `package_unreadable`（ZIP 层）或
  `package_invalid`（清单/文件层），`error.issues[]` 逐条给出 `{ path, message }`。
  **不创建方案、不写照片。**
- `422`：`error.reason = "import_cycle_tolerance_exceeded"`——几何复核发现
  闭合环超容差；`issues[]` 逐条给出 `seam_seq` / `from_seq` / `to_seq` /
  `deviation_mm` / `rotation_deg` / `tolerance_mm` 与冲突链
  （`sherd_seqs` / `seam_seqs` / `closing_seam_seq`）。同样不留任何数据。

### curl 示例

```bash
# 1) 在 A 工作台导出方案 7（响应头里能看到快照版本）
curl -sS -D - -o ~/h3-pot.zip http://workbench-a:8080/api/projects/7/export
#   HTTP/1.1 200 OK
#   Content-Type: application/zip
#   X-Snapshot-Version: 12
#   X-Snapshot-Project-Id: 7

# 2) 在 B 工作台导入（创建独立新方案，重分配本地 ID）
curl -sS -X POST http://workbench-b:8080/api/projects/import \
  -F 'package=@/path/to/h3-pot.zip;type=application/zip'
# => 201 {"project":{"id":3,"name":"…","tolerance_mm":2,"version":1,…},
#         "sherds":[…],"seams":[…],"layout":{…},"imported":true,"source":{…}}

# 3) 损坏/非法包 => 400，issues[] 逐条列出问题
curl -sS -X POST http://workbench-b:8080/api/projects/import -F 'package=@broken.zip'
# => 400 {"error":{"message":"方案包校验未通过（2 项问题），整包拒绝",
#         "reason":"package_invalid",
#         "issues":[{"path":"photos/sherd-0001.png","message":"…SHA-256 校验失败…"}, …]}}
```

Python（requests）示例：

```python
import requests

with open('h3-pot.zip', 'rb') as f:
    r = requests.post('http://workbench-b:8080/api/projects/import',
                      files={'package': ('h3-pot.zip', f, 'application/zip')})
r.raise_for_status()
state = r.json()
print('新方案 id:', state['project']['id'], '陶片:', len(state['sherds']), '接缝:', len(state['seams']))
```

## 数据模型

- `projects`：方案（名称、毫米容差、乐观锁 `version`）。
- `sherds`：陶片（图片文件、图像像素宽高、比例尺 `scale_px`/`scale_mm`）。
- `seams`：有向接缝 `from_id → to_id`，`theta_deg / tx / ty`（把 from 局部毫米坐标
  映射到 to 局部毫米坐标），`join_note` 接缝说明。修订仅 UPDATE 该接缝的这四个字段，
  **不改 id / from_id / to_id**，因此采纳排序（Kruskal 次序）稳定。
- 每次写事务都会把 `projects.version + 1`；布局（连通组、位姿）**只在读取时现算**，
  不入库，因此撤销/修订后天然不会残留旧位置。接缝修订的预览也只现算、不落库。
- 移交包不携带本地自增 id：陶片以导出顺序 `seq`、接缝以采纳顺序 `seq` 互相引用；
  导入时创建新方案并按 `seq` 顺序重分配本地 id（陶片连续编号、接缝按序插入），
  因此导入副本与源方案完全解耦，而布局引擎依据“最小 id 为根 + 采纳序”算出的
  连通组、位姿与闭合环结果与源方案等价。导入不产生写冲突，故不需要 `Base-Version`，
  新方案版本从初始 `v1` 开始。

## 目录结构

```
server.js              Express 入口与 REST API（含乐观锁、成环拒绝、接缝修订预览/确认、批量试拼试算/确认、移交包导出/导入、上传）
src/db.js              SQLite 打开与建表
src/geo.js             刚体变换（旋转/平移、求逆、复合、偏差度量）纯函数
src/layout.js          连通组/生成树(Kruskal 采纳序)/位姿传播/成环评估/残差/接缝修订重算(evaluateSeamRevision)/批量试算(evaluateSeamBatch)
src/zip.js             无依赖 ZIP 读写（STORED/DEFLATE、CRC32 校验，仅供移交包）
src/package.js         移交包清单构建(buildPackage)/整包校验与闭合环复核(inspectPackage)
public/                前端（原生 ES Module + Canvas，无需构建）
  index.html, css/style.css
  js/app.js            路由与首页（含导入方案包）
  js/workspace.js      工作台三栏、画布绘制与交互、轮询、导出方案包按钮
  js/modals.js         比例尺标定弹窗、接缝对齐弹窗
  js/revise.js         接缝修订弹窗（改参 → 自动预览位姿/残差/冲突链 → 确认）
  js/batch.js          批量试拼弹窗（按序填候选 → 只读试算连通组/位姿/闭合环 → 同批同事单事务确认）
  js/geo-client.js     前端几何与卡片布局
  js/api.js, js/ui.js  fetch 封装 / toast、弹窗
test/smoke.js          端到端冒烟测试
Dockerfile, docker-compose.yml
```
