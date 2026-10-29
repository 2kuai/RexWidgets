# RexWidgets

Rex 播放器 Widget 模块仓库。

## 模块合集（一键订阅全部）

```
rex://widget?url=https://raw.githubusercontent.com/2kuai/RexWidgets/main/collection.rex
```

合集文件 `collection.rex` 包含下面全部模块（悬疑剧场、院线电影），在 Rex 中打开上面的链接即可一次添加，之后各模块随仓库自动更新。

## 悬疑剧场

迷雾剧场 / 白夜剧场 / X剧场 悬疑剧集精选，可按「正在热播 / 即将上线」和剧场筛选，支持热度、发布时间、评分排序。

**在 Rex 中添加（订阅链接，自动更新）：**

```
rex://widget?url=https://raw.githubusercontent.com/2kuai/RexWidgets/main/Widgets/SuspenseTheater.js
```

或在 Rex 的模块订阅里填入原始地址：

```
https://raw.githubusercontent.com/2kuai/RexWidgets/main/Widgets/SuspenseTheater.js
```

## 院线电影

正在热映 / 即将上映，可切换分类，支持热度、发布时间、评分排序。

**在 Rex 中添加（订阅链接，自动更新）：**

```
rex://widget?url=https://raw.githubusercontent.com/2kuai/RexWidgets/main/Widgets/CinemaMovies.js
```

原始地址：`https://raw.githubusercontent.com/2kuai/RexWidgets/main/Widgets/CinemaMovies.js`

院线数据：豆瓣榜单（in_theaters / coming_soon）为种子 + TMDB 严格匹配（片名或原名全等才收录），生成脚本 `scripts/update-cinema-movies-data.js` 输出 `data/douban_movie_data.json`，工作流 `.github/workflows/update-cinema-movies-data.yml` 每天 18:00 UTC 自动运行（失败自动重试 3 次）。

## 数据自动化

- 数据来源：豆瓣豆列（迷雾剧场 / 白夜剧场 / X剧场）+ TMDB 精确匹配（片名全等 + 年份）。
- 生成脚本：`scripts/update-theater-data.js`，输出 `data/theater-data.json`，写入前经 `scripts/lib/data-contract.cjs` 校验字段契约，校验不过不落盘。
- 定时任务：`.github/workflows/update-theater-data.yml`，每天 04:00 UTC 自动运行（失败自动重试 3 次），数据有变化才提交。
- 手动触发：Actions 页面选择 “Update Theater Collection Data” → Run workflow。

### 首次启用需要配置（仓库所有者操作）

工作流需要 TMDB API 读令牌。到本仓库 **Settings → Secrets and variables → Actions** 新增一个 secret：

- Name：`TMDB_API_KEY`
- Value：TMDB API Read Access Token（v4 令牌）

不配置的话工作流会直接报错退出，不会写坏已有数据。

院线电影工作流额外需要两个 secret（与 ForwardWidgets 仓库同名同值）：`DOUBAN_API_KEY`、`BASE_URL`。
