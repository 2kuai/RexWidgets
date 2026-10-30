/**
 * RexWidgets 数据生成（统一入口）
 *
 * 用法：
 *   node scripts/update-data.js theater          生成悬疑剧场数据（data/theater-data.json）
 *   node scripts/update-data.js cinema           生成院线电影数据（data/cinema-movies.json）
 *   node scripts/update-data.js all              依次生成以上两者
 *   node scripts/update-data.js validate <文件>  按共享契约校验已有数据文件
 *
 * 环境变量：
 *   TMDB_API_KEY    TMDB v3 API Key（api_key 查询参数鉴权），theater / cinema 都需要
 *   DOUBAN_API_KEY  豆瓣 API Key，仅 cinema 需要
 *   BASE_URL        豆瓣 API 地址，可选，默认 https://api.douban.com/v2/movie
 *
 * 通用策略（两个数据源一致）：
 *   - TMDB 查询走并发池（5）+ 单条容错，单个条目失败只跳过计数，不拖垮整轮；
 *   - 单个分类 / 剧场整体失败时保留上一版数据，全部失败才让整轮失败；
 *   - 写盘前经 lib/data-contract.js 校验字段契约，校验不过不落盘。
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateData, writeValidatedJson } from './lib/data-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const DOUBAN_API_KEY = process.env.DOUBAN_API_KEY;
const DOUBAN_BASE_URL = process.env.BASE_URL || 'https://api.douban.com/v2/movie';

const TMDB_SEARCH_URL = 'https://api.themoviedb.org/3/search';
const CONCURRENCY = 5;
const HTTP_TIMEOUT = 15000;
const MAX_ATTEMPTS = 3;

// TMDB 类型 ID -> 中文名（电影与剧集各一份，口径与历史数据一致）
const MOVIE_GENRES = {
  28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录', 18: '剧情',
  10751: '家庭', 14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐', 9648: '悬疑',
  10749: '爱情', 878: '科幻', 10770: '电视电影', 53: '惊悚', 10752: '战争', 37: '西部'
};
const TV_GENRES = {
  ...MOVIE_GENRES,
  99: '纪录片',
  10759: '动作冒险', 10762: '儿童', 10763: '新闻', 10764: '真人秀', 10765: '科幻奇幻',
  10766: '肥皂剧', 10767: '脱口秀', 10768: '战争政治'
};

// ---------- 通用工具 ----------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 通用重试：网络错误 / 429 / 5xx 才重试，退避 1s、2s
async function withRetry(label, fn, attempts = MAX_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === attempts) break;
      const delay = 1000 * attempt;
      console.warn(`${label} 第 ${attempt} 次失败（${error.message}），${delay}ms 后重试`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// 简单并发池，保持结果顺序
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function readPrevious(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function toMediaRecord(match, mediaType, genreMap, overrides = {}) {
  return {
    id: match.id,
    type: 'tmdb',
    title: mediaType === 'tv' ? match.name : match.title,
    description: match.overview || '',
    rating: match.vote_average || 0,
    voteCount: match.vote_count || 0,
    popularity: match.popularity || 0,
    releaseDate: (mediaType === 'tv' ? match.first_air_date : match.release_date) || '',
    posterPath: match.poster_path || '',
    backdropPath: match.backdrop_path || '',
    mediaType,
    genreTitle: (match.genre_ids || []).map(id => genreMap[id]).filter(Boolean).join(','),
    ...overrides
  };
}

// ---------- 悬疑剧场（豆瓣豆列 + TMDB 精确匹配） ----------

const THEATERS = [
  { name: '迷雾剧场', id: '128396349' },
  { name: '白夜剧场', id: '158539495' },
  { name: 'X剧场', id: '155026800' }
];
const THEATER_DATA_FILE = path.join(DATA_DIR, 'theater-data.json');
const DOULIST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1'
};

function parseDoubanTitle(doubanTitle) {
  const match = doubanTitle.match(/^(.*?)(?:\((\d{4})\))?$/);
  if (match) {
    return { title: match[1].trim(), year: match[2] || null };
  }
  return { title: doubanTitle.trim(), year: null };
}

// 抓一个豆列的全部分页，返回去重后的 [{ title, year }]
async function fetchDoulistItems(theaterName, doulistId) {
  const baseUrl = `https://m.douban.com/doulist/${doulistId}/`;
  const pageSize = 25;
  const seen = new Set();
  const items = [];
  let start = 0;
  let pageCount = 0;

  while (true) {
    pageCount++;
    const pageUrl = start === 0 ? baseUrl : `${baseUrl}?start=${start}`;
    const response = await withRetry(`${theaterName} 第 ${pageCount} 页`, () =>
      axios.get(pageUrl, { headers: DOULIST_HEADERS, timeout: HTTP_TIMEOUT })
    );
    if (!response?.data) break;

    const $ = cheerio.load(response.data);
    const pageItems = $('ul.doulist-items > li');
    pageItems.each((index, element) => {
      const title = $(element).find('.info .title').text().trim();
      if (!title) return;
      const meta = $(element).find('.info .meta').text().trim();
      const year = meta.match(/(\d{4})(?=-\d{2}-\d{2})/)?.[1] || '';
      const key = `${title}|${year}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ title, year });
    });

    if (pageItems.length < pageSize) break;
    start += pageSize;
    await sleep(500);
  }

  return { items, pageCount };
}

const tmdbTvCache = new Map();

// TMDB 精确匹配：片名全等（+年份一致），不放宽
function searchTmdbTv(title, year = null) {
  const cacheKey = `${title}|${year || ''}`;
  if (tmdbTvCache.has(cacheKey)) return tmdbTvCache.get(cacheKey);

  const promise = (async () => {
    const params = { query: title, language: 'zh-CN', api_key: TMDB_API_KEY };
    if (year) params.first_air_date_year = year;

    const response = await withRetry(`TMDB「${title}」`, () =>
      axios.get(`${TMDB_SEARCH_URL}/tv`, { params, timeout: HTTP_TIMEOUT })
    );

    const results = response.data?.results || [];
    const exactMatch = results.find(result => {
      const isTitleMatch = result.name?.trim().toLowerCase() === title.trim().toLowerCase();
      if (!isTitleMatch) return false;
      if (year) {
        const releaseYear = result.first_air_date ? new Date(result.first_air_date).getFullYear() : null;
        return releaseYear === parseInt(year);
      }
      return true;
    });
    if (!exactMatch) return null;

    return toMediaRecord(exactMatch, 'tv', TV_GENRES);
  })();

  tmdbTvCache.set(cacheKey, promise);
  return promise;
}

async function buildTheater(theater) {
  console.log(`开始获取 ${theater.name} 剧场数据`);
  const { items, pageCount } = await fetchDoulistItems(theater.name, theater.id);
  console.log(`${theater.name}：豆列共 ${items.length} 条，开始匹配 TMDB`);

  let failed = 0;
  const matched = await mapPool(items, CONCURRENCY, async item => {
    const fullTitle = item.year ? `${item.title}(${item.year})` : item.title;
    const { title, year } = parseDoubanTitle(fullTitle);
    try {
      return await searchTmdbTv(title, year);
    } catch (error) {
      failed++;
      console.warn(`${theater.name}「${title}」匹配失败，已跳过：${error.message}`);
      return null;
    }
  });
  if (failed > 0) console.warn(`${theater.name}：${failed} 条匹配失败被跳过`);

  const now = Date.now();
  const aired = [];
  const upcoming = [];
  for (const show of matched) {
    if (!show) continue;
    const t = Date.parse(show.releaseDate);
    if (!Number.isNaN(t) && t <= now) aired.push(show);
    else upcoming.push(show);
  }

  aired.sort((a, b) => (Date.parse(b.releaseDate) || 0) - (Date.parse(a.releaseDate) || 0));
  // 即将上线按开播时间升序（最近的在前），无日期的排最后
  upcoming.sort((a, b) => (Date.parse(a.releaseDate) || Infinity) - (Date.parse(b.releaseDate) || Infinity));

  return {
    [theater.name]: {
      aired,
      upcoming,
      totalItems: items.length,
      totalPages: pageCount
    }
  };
}

async function updateTheater() {
  if (!TMDB_API_KEY) {
    throw new Error('TMDB_API_KEY environment variable is required.');
  }

  const previous = readPrevious(THEATER_DATA_FILE);
  const data = {
    last_updated: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00')
  };

  // 单个剧场整体失败时保留上一版该剧场数据；全部失败才让整轮失败
  let successCount = 0;
  for (const theater of THEATERS) {
    try {
      Object.assign(data, await buildTheater(theater));
      successCount++;
    } catch (error) {
      console.error(`${theater.name} 更新失败：${error.message}`);
      if (previous?.[theater.name]) {
        console.warn(`${theater.name}：保留上一版数据`);
        data[theater.name] = previous[theater.name];
      }
    }
  }
  if (successCount === 0) {
    throw new Error('All theater collections failed to update.');
  }

  writeValidatedJson(THEATER_DATA_FILE, data, {
    label: 'Douban theater collections',
    requiredCollectionGroups: THEATERS.map(theater => ({
      label: theater.name,
      paths: [[theater.name, 'aired'], [theater.name, 'upcoming']]
    }))
  });
}

// ---------- 院线电影（豆瓣榜单种子 + TMDB 严格匹配） ----------

// 分类：豆瓣端点 -> 输出字段
const MOVIE_CATEGORIES = [
  { endpoint: 'in_theaters', key: 'now_playing', label: '正在热映' },
  { endpoint: 'coming_soon', key: 'coming_soon', label: '即将上映' }
];
const CINEMA_DATA_FILE = path.join(DATA_DIR, 'cinema-movies.json');
const DOUBAN_PAGE_SIZE = 100;

// TMDB 严格匹配：只收标题严格一致的（title 全等或 original_title 全等），
// TMDB 没封面时用豆瓣封面兜底；搜不到或不匹配就丢弃，不放宽。
async function searchTmdbMovie(doubanItem) {
  const title = doubanItem.title;
  const originalTitle = doubanItem.original_title;
  const searchQuery = originalTitle || title;

  const searchRes = await withRetry(`TMDB「${title}」`, () =>
    axios.get(`${TMDB_SEARCH_URL}/movie`, {
      params: { query: searchQuery, language: 'zh-CN', api_key: TMDB_API_KEY },
      timeout: 10000
    })
  );

  const results = searchRes.data?.results || [];
  const match = results.find(m => (m.title == title || m.original_title == originalTitle)) || null;
  if (!match) return null;

  return toMediaRecord(match, 'movie', MOVIE_GENRES, {
    releaseDate: match.release_date || doubanItem.year || '',
    posterPath: match.poster_path || doubanItem.images?.large || '',
    backdropPath: match.backdrop_path || doubanItem.images?.large || ''
  });
}

async function fetchDoubanSubjects(endpoint) {
  const allSubjects = [];
  let start = 0;

  while (true) {
    const res = await withRetry(`豆瓣 ${endpoint} [${start}]`, () =>
      axios.post(`${DOUBAN_BASE_URL}/${endpoint}`, {
        apikey: DOUBAN_API_KEY,
        start,
        count: DOUBAN_PAGE_SIZE
      }, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU OS 17_0 like Mac OS X)' },
        timeout: HTTP_TIMEOUT
      })
    );

    const subjects = res.data?.subjects || [];
    if (subjects.length === 0) break;
    allSubjects.push(...subjects);

    const total = res.data?.total;
    if (subjects.length < DOUBAN_PAGE_SIZE || (typeof total === 'number' && allSubjects.length >= total)) break;
    start += DOUBAN_PAGE_SIZE;
    await sleep(600);
  }

  // 同一分类内按豆瓣条目去重，避免重复打 TMDB
  const seen = new Set();
  return allSubjects.filter(item => {
    const key = item.id || `${item.title}|${item.year}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildMovieCategory(category) {
  console.log(`开始同步分类：${category.label}（${category.endpoint}）`);
  const subjects = await fetchDoubanSubjects(category.endpoint);
  console.log(`${category.label}：种子 ${subjects.length} 条，开始匹配 TMDB`);

  let failed = 0;
  const matched = await mapPool(subjects, CONCURRENCY, async item => {
    try {
      return await searchTmdbMovie(item);
    } catch (error) {
      failed++;
      console.warn(`「${item.title}」匹配失败，已跳过：${error.message}`);
      return null;
    }
  });
  if (failed > 0) console.warn(`${category.label}：${failed} 条匹配失败被跳过`);

  // 同一电影在同分类内按 TMDB id 去重
  const seenIds = new Set();
  const results = matched.filter(item => {
    if (!item || seenIds.has(item.id)) return false;
    seenIds.add(item.id);
    return true;
  });

  console.log(`${category.label} 处理完毕，有效 ${results.length} 条，过滤 ${subjects.length - results.length} 条`);
  return results;
}

async function updateCinema() {
  if (!TMDB_API_KEY || !DOUBAN_API_KEY) {
    throw new Error('TMDB_API_KEY and DOUBAN_API_KEY environment variables are required.');
  }

  const previous = readPrevious(CINEMA_DATA_FILE);
  const data = { updated_at: new Date().toISOString() };

  // 单个分类整体失败时保留上一版该分类数据；全部失败才让整轮失败
  let successCount = 0;
  for (const category of MOVIE_CATEGORIES) {
    try {
      data[category.key] = await buildMovieCategory(category);
      successCount++;
    } catch (error) {
      console.error(`${category.label} 更新失败：${error.message}`);
      if (Array.isArray(previous?.[category.key]) && previous[category.key].length > 0) {
        console.warn(`${category.label}：保留上一版数据`);
        data[category.key] = previous[category.key];
      } else {
        data[category.key] = [];
      }
    }
  }
  if (successCount === 0) {
    throw new Error('All movie categories failed to update.');
  }

  writeValidatedJson(CINEMA_DATA_FILE, data, {
    label: 'Douban movie lists',
    requiredCollections: MOVIE_CATEGORIES.map(c => [c.key])
  });

  const total = MOVIE_CATEGORIES.reduce((sum, c) => sum + (data[c.key]?.length || 0), 0);
  console.log(`院线电影有效数据总量：${total}`);
}

// ---------- 入口 ----------

function validateFiles(filePaths) {
  if (filePaths.length === 0) {
    throw new Error('Usage: node scripts/update-data.js validate <data-file> [more-files...]');
  }
  for (const filePath of filePaths) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const recordCount = validateData(data);
    console.log(`[data] ${path.basename(filePath)}: ${recordCount} media records match the shared contract.`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'theater':
      await updateTheater();
      break;
    case 'cinema':
      await updateCinema();
      break;
    case 'all': {
      // 两组数据都尝试生成，任一失败则整轮失败（供工作流统一重试）
      const failures = [];
      for (const [label, run] of [['悬疑剧场', updateTheater], ['院线电影', updateCinema]]) {
        try {
          await run();
        } catch (error) {
          failures.push(`${label}: ${error.message}`);
          console.error(`${label} 更新失败：${error.message}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`Failed targets — ${failures.join('; ')}`);
      }
      break;
    }
    case 'validate':
      validateFiles(rest);
      break;
    default:
      throw new Error('Usage: node scripts/update-data.js <theater|cinema|all|validate> [files...]');
  }
}

main().catch(error => {
  console.error('更新失败:', error.stack || error.message);
  process.exitCode = 1;
});
