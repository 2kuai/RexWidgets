# RexWidgets

Rex 播放器 Widget 模块仓库。模块数据由 GitHub Actions 每日自动生成，订阅后随仓库自动更新。

## 模块

只有一个模块文件 `widgets/rex-widgets.js`，内含下面三个模块，一次订阅全部到手：

```
rex://widget?url=https://raw.githubusercontent.com/2kuai/RexWidgets/main/widgets/rex-widgets.js
```

原始地址：`https://raw.githubusercontent.com/2kuai/RexWidgets/main/widgets/rex-widgets.js`

### 悬疑剧场

迷雾剧场 / 白夜剧场 / X剧场 悬疑剧集精选，可按「正在热播 / 即将上线」和剧场筛选，支持热度、发布时间、评分排序。

### 网播热度

猫眼网播热度榜，可先选类别（电视剧+网络剧 / 综艺），再按全网 / 优酷 / 爱奇艺 / 腾讯视频 / 乐视 / 搜狐 / PPTV / 芒果TV 切换榜单，默认按榜单名次（热度）排列，支持发布时间、评分排序。

### 院线电影

正在热映 / 即将上映，可切换分类，支持热度、发布时间、评分排序。

## 仓库结构

```
widgets/                  Rex 模块（订阅入口）
  rex-widgets.js          全部模块（悬疑剧场 + 院线电影 + 网播热度）
data/                     自动生成的数据（勿手改）
  theater-data.json       悬疑剧场数据
  cinema-movies.json      院线电影数据
  maoyan-web-heat.json    猫眼网播热度（剧集 / 综艺 × 分平台榜单，统一契约格式）
scripts/
  update-data.js          数据生成统一入口（theater / cinema / maoyan / all / validate）
  lib/data-contract.js    生成数据的字段契约与写盘校验
.github/workflows/
  update-data.yml         每日定时生成并提交数据
```

## 数据自动化

统一脚本 `scripts/update-data.js`，子命令区分数据源：

| 子命令 | 数据 | 来源 | 输出 |
| --- | --- | --- | --- |
| `theater` | 悬疑剧场 | 豆瓣豆列（迷雾 / 白夜 / X剧场）+ TMDB 精确匹配（片名全等 + 年份） | `data/theater-data.json` |
| `cinema` | 院线电影 | 豆瓣榜单（in_theaters / coming_soon）为种子 + TMDB 严格匹配（片名或原名全等才收录） | `data/cinema-movies.json` |
| `maoyan` | 猫眼网播热度 | 猫眼网播热度榜（电视剧+网络剧 / 综艺两类，各含全网 + 优酷 / 爱奇艺 / 腾讯视频 / 乐视 / 搜狐 / PPTV / 芒果TV 共 16 个榜单）为种子 + TMDB 匹配（片名全等优先；综艺等带季数 / 年份后缀的，剥后缀再全等兜底）；接口带 H5guard 签名校验，用 Playwright 无头浏览器在页面内发请求取榜，热度写入 `popularity` 并另存 `heat` 字段 | `data/maoyan-web-heat.json` |
| `all` | 三者依次生成 | 同上 | 同上 |
| `validate <文件>` | — | 按 `scripts/lib/data-contract.js` 的共享契约校验已有数据文件 | — |

生成策略：TMDB 查询并发池 + 单条容错；单个剧场 / 分类 / 榜单整体失败时保留上一版数据，全部失败才整轮失败；写盘前先过契约校验，校验不过不落盘。猫眼热度文件每日覆盖，历史靠 git 提交记录归档。

工作流 `.github/workflows/update-data.yml`（失败自动重试 3 次，数据有变化才提交）：

- 每天 04:00 UTC 自动生成悬疑剧场，18:00 UTC 自动生成院线电影，15:50 UTC（北京时间 23:50）自动生成猫眼网播热度；
- 也可在 Actions 页面手动触发 “Update Widget Data”，用 `target` 参数选 `all` / `theater` / `cinema` / `maoyan`。

本地运行：`npm run update`（全部）、`npm run update:theater`、`npm run update:cinema`、`npm run update:maoyan`（需先 `npx playwright install chromium`）、`npm run validate -- data/theater-data.json`。

### 首次启用需要配置（仓库所有者操作）

到本仓库 **Settings → Secrets and variables → Actions** 新增两个 secret：

- `TMDB_API_KEY`：TMDB API Key（v3 短格式密钥；脚本以 `api_key` 查询参数方式鉴权，不用 v4 长令牌），三个数据源都需要；
- `DOUBAN_API_KEY`：豆瓣 API Key，仅院线电影需要。

`BASE_URL` 无需配置，不配时脚本使用内置的豆瓣官方地址 `https://api.douban.com/v2/movie`。不配置密钥的话工作流会直接报错退出，不会写坏已有数据。
