import axios from 'axios';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dataContract from './lib/data-contract.cjs';

const { writeValidatedJson } = dataContract;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= 配置 =================
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const DOUBAN_API_KEY = process.env.DOUBAN_API_KEY;
const BASE_URL = process.env.BASE_URL || "https://api.douban.com/v2/movie";

const GENRE_MAP = {
    28: "动作", 12: "冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 99: "纪录", 18: "剧情",
    10751: "家庭", 14: "奇幻", 36: "历史", 27: "恐怖", 10402: "音乐", 9648: "悬疑",
    10749: "爱情", 878: "科幻", 10770: "电视电影", 53: "惊悚", 10752: "战争", 37: "西部"
};

// 分类：豆瓣端点 -> 输出字段
const CATEGORIES = [
    { endpoint: 'in_theaters', key: 'now_playing', label: '正在热映' },
    { endpoint: 'coming_soon', key: 'coming_soon', label: '即将上映' },
    { endpoint: 'top250', key: 'top250', label: 'Top250' }
];

const MAX_COUNT = 100;
const REQUEST_TIMEOUT = 15000;
// 旧版逐条串行匹配 + 每条固定 150ms 间隔，300 多条要跑数分钟且任一条失败整类作废；
// 改为并发池 + 单条容错 + 失败保留上一版分类数据。
const TMDB_CONCURRENCY = 5;
const MAX_ATTEMPTS = 3;

// 输出路径按脚本位置定位（旧版用相对 CWD 的 ./data，从别的目录启动会写错地方）
const FILE_PATH = path.join(__dirname, '..', 'data', 'douban_movie_data.json');

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

// ================= TMDB 严格匹配 =================
/**
 * 与旧版口径一致：只收标题严格一致的（title 全等或 original_title 全等），
 * TMDB 没封面时用豆瓣封面兜底；搜不到或不匹配就丢弃，不放宽。
 */
async function getStrictTMDBData(doubanItem) {
    const title = doubanItem.title;
    const originalTitle = doubanItem.original_title;
    const searchQuery = originalTitle || title;

    const searchRes = await withRetry(`TMDB「${title}」`, () =>
        axios.get('https://api.themoviedb.org/3/search/movie', {
            params: { query: searchQuery, language: 'zh-CN' },
            headers: { 'Authorization': `Bearer ${TMDB_API_KEY}` },
            timeout: 10000
        })
    );

    const results = searchRes.data?.results || [];
    const match = results.find(m => (m.title == title || m.original_title == originalTitle)) || null;
    if (!match) return null;

    return {
        id: match.id,
        type: "tmdb",
        title: match.title,
        description: match.overview || "",
        rating: match.vote_average || 0,
        voteCount: match.vote_count || 0,
        popularity: match.popularity || 0,
        releaseDate: match.release_date || doubanItem.year,
        posterPath: match.poster_path || doubanItem.images?.large || "",
        backdropPath: match.backdrop_path || doubanItem.images?.large || "",
        mediaType: "movie",
        genreTitle: (match.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean).join(',')
    };
}

// ================= 豆瓣种子 =================
async function fetchDoubanSubjects(endpoint) {
    const allSubjects = [];
    let start = 0;

    while (true) {
        const res = await withRetry(`豆瓣 ${endpoint} [${start}]`, () =>
            axios.post(`${BASE_URL}/${endpoint}`, {
                apikey: DOUBAN_API_KEY,
                start: start,
                count: MAX_COUNT
            }, {
                headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU OS 17_0 like Mac OS X)' },
                timeout: REQUEST_TIMEOUT
            })
        );

        const subjects = res.data?.subjects || [];
        if (subjects.length === 0) break;
        allSubjects.push(...subjects);

        if (endpoint !== 'top250' || allSubjects.length >= (res.data.total || 250)) break;
        start += MAX_COUNT;
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

async function buildCategory(category) {
    console.log(`\n===> 同步分类: ${category.label} (${category.endpoint})`);
    const subjects = await fetchDoubanSubjects(category.endpoint);
    console.log(`种子 ${subjects.length} 条，开始匹配 TMDB`);

    let failed = 0;
    const matched = await mapPool(subjects, TMDB_CONCURRENCY, async item => {
        try {
            return await getStrictTMDBData(item);
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

function readPrevious() {
    try {
        return JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    } catch {
        return null;
    }
}

async function main() {
    const startTime = Date.now();
    console.log('🎬 启动院线电影数据采集（豆瓣种子 + TMDB 严格匹配）...');

    if (!TMDB_API_KEY || !DOUBAN_API_KEY) {
        throw new Error('TMDB_API_KEY and DOUBAN_API_KEY environment variables are required.');
    }

    const previous = readPrevious();
    const finalResult = { updated_at: new Date().toISOString() };

    // 单个分类整体失败时保留上一版该分类数据；全部失败才让整轮失败
    let successCount = 0;
    for (const category of CATEGORIES) {
        try {
            finalResult[category.key] = await buildCategory(category);
            successCount++;
        } catch (error) {
            console.error(`${category.label} 更新失败：${error.message}`);
            if (Array.isArray(previous?.[category.key]) && previous[category.key].length > 0) {
                console.warn(`${category.label}：保留上一版数据`);
                finalResult[category.key] = previous[category.key];
            } else {
                finalResult[category.key] = [];
            }
        }
    }
    if (successCount === 0) {
        throw new Error('All movie categories failed to update.');
    }

    writeValidatedJson(FILE_PATH, finalResult, {
        label: 'Douban movie lists',
        requiredCollections: CATEGORIES.map(c => [c.key])
    });

    const total = CATEGORIES.reduce((sum, c) => sum + (finalResult[c.key]?.length || 0), 0);
    console.log(`\n📊 有效数据总量: ${total}`);
    console.log(`📂 文件存放在: ${FILE_PATH}`);
    console.log(`⏱️ 耗时: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
}

main().catch(error => {
    console.error('更新失败:', error.stack || error.message);
    process.exitCode = 1;
});
