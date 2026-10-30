var WidgetMetadata = {
  id: 'suspense_theater',
  title: '悬疑剧场',
  description: '迷雾剧场 / 白夜剧场 / X剧场 悬疑剧集精选，数据每日自动更新',
  author: '两块',
  site: 'https://github.com/2kuai/RexWidgets',
  version: '1.1.0',
  requiredVersion: '0.0.1',
  globalParams: [
    {
      name: 'githubProxy',
      title: 'GitHub 加速源',
      type: 'input',
      placeholders: [
        { title: 'ghproxy', value: 'https://ghproxy.net/' }
      ]
    }
  ],
  modules: [
    {
      title: '悬疑剧场',
      functionName: 'getSuspenseTheater',
      cacheDuration: 43200,
      params: [
        {
          name: 'status',
          title: '类别',
          type: 'enumeration',
          enumOptions: [
            { title: '正在热播', value: 'aired' },
            { title: '即将上线', value: 'upcoming' }
          ]
        },
        {
          name: 'platformId',
          title: '剧场',
          type: 'enumeration',
          enumOptions: [
            { title: '全部剧场', value: 'all' },
            { title: '迷雾剧场', value: '迷雾剧场' },
            { title: '白夜剧场', value: '白夜剧场' },
            { title: 'X剧场', value: 'X剧场' }
          ]
        },
        {
          name: 'sort_by',
          title: '排序',
          type: 'enumeration',
          enumOptions: [
            { title: '排序', value: 'default' },
            { title: '热度最高', value: 'popularity' },
            { title: '发布时间', value: 'time' },
            { title: '评分最高', value: 'rating' }
          ]
        }
      ]
    }
  ]
};

const DATA_URL = 'https://raw.githubusercontent.com/2kuai/RexWidgets/main/data/theater-data.json';

const Utils = {
  emptyTips: [{ id: 'empty', type: 'text', title: '⚠️ 加载失败', description: '请检查网络或配置 GitHub 加速' }],

  // 失败返回 null（旧版返回 emptyTips 数组，调用方误当数据处理会静默出错）
  async fetchData(proxy) {
    const url = `${proxy || ''}${DATA_URL}`;
    try {
      const resp = await Widget.http.get(url);
      const data = resp?.data;
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (e) {
      console.error(`[Error] ${url}: ${e.message}`);
      return null;
    }
  },

  // 同一部剧可能同时出现在多个剧场豆列里，合并时按 TMDB id 去重
  dedupe(list) {
    const seen = new Set();
    return list.filter(item => {
      if (item?.id == null) return true;
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  },

  sortList(list, sortBy) {
    if (!sortBy || sortBy === 'default' || list.length < 2) return list;
    const sorted = [...list];
    switch (sortBy) {
      case 'rating':
        return sorted.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
      case 'popularity':
        return sorted.sort((a, b) => (parseFloat(b.popularity) || 0) - (parseFloat(a.popularity) || 0));
      case 'time':
        return sorted.sort((a, b) => (Date.parse(b.releaseDate) || 0) - (Date.parse(a.releaseDate) || 0));
      default:
        return list;
    }
  }
};

/**
 * 悬疑剧场
 * 数据由 GitHub Actions 每日抓取豆列 + TMDB 匹配生成，见 scripts/update-data.js（theater）
 */
async function getSuspenseTheater(params = {}) {
  const data = await Utils.fetchData(params.githubProxy);
  if (!data) return Utils.emptyTips;

  const section = params.status || 'aired';
  let list;
  if (!params.platformId || params.platformId === 'all') {
    list = Object.keys(data)
      .filter(k => k !== 'last_updated')
      .flatMap(k => data[k]?.[section] || []);
    list = Utils.dedupe(list);
  } else {
    list = data[params.platformId]?.[section] || [];
  }

  return Utils.sortList(list, params.sort_by);
}
