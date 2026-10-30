var WidgetMetadata = {
  id: 'rex_widgets',
  title: 'RexWidgets',
  description: '悬疑剧场 + 院线电影 + 网播热度，数据每日自动更新',
  author: '两块',
  site: 'https://github.com/2kuai/RexWidgets',
  version: '1.2.1',
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
    },
    {
      title: '网播热度',
      functionName: 'getMaoyanHeat',
      cacheDuration: 43200,
      params: [
        {
          name: 'category',
          title: '类别',
          type: 'enumeration',
          enumOptions: [
            { title: '电视剧+网络剧', value: 'tv' },
            { title: '综艺', value: 'variety' }
          ]
        },
        {
          name: 'platform',
          title: '平台',
          type: 'enumeration',
          enumOptions: [
            { title: '全网', value: 'all' },
            { title: '优酷', value: 'youku' },
            { title: '爱奇艺', value: 'iqiyi' },
            { title: '腾讯视频', value: 'tencent' },
            { title: '芒果TV', value: 'mgtv' }
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
    },
    {
      title: '院线电影',
      functionName: 'getMovies',
      cacheDuration: 43200,
      params: [
        {
          name: 'sort',
          title: '类型',
          type: 'enumeration',
          enumOptions: [
            { title: '正在热映', value: 'now_playing' },
            { title: '即将上映', value: 'coming_soon' }
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

const THEATER_DATA_URL = 'https://raw.githubusercontent.com/2kuai/RexWidgets/main/data/theater-data.json';
const CINEMA_DATA_URL = 'https://raw.githubusercontent.com/2kuai/RexWidgets/main/data/cinema-movies.json';
const MAOYAN_DATA_URL = 'https://raw.githubusercontent.com/2kuai/RexWidgets/main/data/maoyan-web-heat.json';

const Utils = {
  emptyTips: [{ id: 'empty', type: 'text', title: '⚠️ 加载失败', description: '请检查网络或配置 GitHub 加速' }],

  // 失败返回 null（旧版返回 emptyTips 数组，调用方误当数据处理会静默出错）
  async fetchData(proxy, dataUrl) {
    const url = `${proxy || ''}${dataUrl}`;
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
  const data = await Utils.fetchData(params.githubProxy, THEATER_DATA_URL);
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

/**
 * 院线电影
 * 数据由 GitHub Actions 每日以豆瓣榜单为种子 + TMDB 严格匹配生成，
 * 见 scripts/update-data.js（cinema）
 */
async function getMovies(params = {}) {
  const data = await Utils.fetchData(params.githubProxy, CINEMA_DATA_URL);
  if (!data) return Utils.emptyTips;

  const list = data[params.sort || 'now_playing'] || [];
  return Utils.sortList(list, params.sort_by);
}

/**
 * 网播热度
 * 数据由 GitHub Actions 每日以猫眼网播热度榜（电视剧+网络剧 / 综艺）为种子 + TMDB 精确匹配生成，
 * 见 scripts/update-data.js（maoyan）。默认顺序即榜单名次（热度写入 popularity）
 */
async function getMaoyanHeat(params = {}) {
  const data = await Utils.fetchData(params.githubProxy, MAOYAN_DATA_URL);
  if (!data) return Utils.emptyTips;

  const boards = data[params.category || 'tv'] || {};
  const list = boards[params.platform || 'all'] || [];
  return Utils.sortList(list, params.sort_by);
}
