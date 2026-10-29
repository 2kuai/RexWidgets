var WidgetMetadata = {
  id: "cinema_movies",
  title: "院线电影",
  description: "正在热映 / 即将上映 / 豆瓣 Top250，数据每日自动更新",
  author: "两块",
  site: "https://github.com/2kuai/RexWidgets",
  version: "1.0.0",
  requiredVersion: "0.0.1",
  globalParams: [
    {
      name: "githubProxy",
      title: "GitHub 加速源",
      type: "input",
      placeholders: [
        { title: "ghproxy", value: "https://ghproxy.net/" }
      ]
    }
  ],
  modules: [
    {
      title: "院线电影",
      functionName: "getMovies",
      cacheDuration: 43200,
      params: [
        {
          name: "sort",
          title: "类型",
          type: "enumeration",
          enumOptions: [
            { title: "正在热映", value: "now_playing" },
            { title: "即将上映", value: "coming_soon" },
            { title: "经典影片", value: "top250" }
          ]
        },
        {
          name: "sort_by",
          title: "排序",
          type: "enumeration",
          enumOptions: [
            { title: "排序", value: "default" },
            { title: "热度最高", value: "popularity" },
            { title: "发布时间", value: "time" },
            { title: "评分最高", value: "rating" }
          ]
        }
      ]
    }
  ]
};

const DATA_URL = "https://raw.githubusercontent.com/2kuai/RexWidgets/main/data/douban_movie_data.json";

const Utils = {
  emptyTips: [{ id: "empty", type: "text", title: "⚠️ 加载失败", description: "请检查网络或配置 GitHub 加速" }],

  // 失败返回 null（旧版返回 emptyTips 数组，调用方误当数据处理会静默出错）
  async fetchData(proxy) {
    const url = `${proxy || ""}${DATA_URL}`;
    try {
      const resp = await Widget.http.get(url);
      const data = resp?.data;
      return data && typeof data === "object" && !Array.isArray(data) ? data : null;
    } catch (e) {
      console.error(`[Error] ${url}: ${e.message}`);
      return null;
    }
  },

  sortList(list, sortBy) {
    if (!sortBy || sortBy === "default" || list.length < 2) return list;
    const sorted = [...list];
    switch (sortBy) {
      case "rating":
        return sorted.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
      case "popularity":
        return sorted.sort((a, b) => (parseFloat(b.popularity) || 0) - (parseFloat(a.popularity) || 0));
      case "time":
        return sorted.sort((a, b) => (Date.parse(b.releaseDate) || 0) - (Date.parse(a.releaseDate) || 0));
      default:
        return list;
    }
  }
};

/**
 * 院线电影
 * 数据由 GitHub Actions 每日以豆瓣榜单为种子 + TMDB 严格匹配生成，
 * 见 scripts/update-cinema-movies-data.js
 */
async function getMovies(params = {}) {
  const data = await Utils.fetchData(params.githubProxy);
  if (!data) return Utils.emptyTips;

  const list = data[params.sort || "now_playing"] || [];
  return Utils.sortList(list, params.sort_by);
}
