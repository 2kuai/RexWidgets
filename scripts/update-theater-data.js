import axios from 'axios';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import dataContract from './lib/data-contract.cjs';

const { writeValidatedJson } = dataContract;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3/search/tv';

// 并发与重试参数：旧版逐条串行查 TMDB（每条固定 sleep 200ms），
// 一个豆列上百条要跑几分钟且任一条失败整轮作废；改为并发池 + 单条容错。
const TMDB_CONCURRENCY = 5;
const HTTP_TIMEOUT = 15000;
const MAX_ATTEMPTS = 3;

const GENRE_MAP = {
    28: "动作", 12: "冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 99: "纪录片", 18: "剧情",
    10751: "家庭", 14: "奇幻", 36: "历史", 27: "恐怖", 10402: "音乐", 9648: "悬疑",
    10749: "爱情", 878: "科幻", 10770: "电视电影", 53: "惊悚", 10752: "战争", 37: "西部",
    10759: "动作冒险", 10762: "儿童", 10763: "新闻", 10764: "真人秀", 10765: "科幻奇幻",
    10766: "肥皂剧", 10767: "脱口秀", 10768: "战争政治"
};

const THEATERS = [
    { name: "迷雾剧场", id: "128396349" },
    { name: "白夜剧场", id: "158539495" },
    { name: "X剧场", id: "155026800" }
];

const DOUBAN_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1'
};

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
            axios.get(pageUrl, { headers: DOUBAN_HEADERS, timeout: HTTP_TIMEOUT })
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

const tmdbCache = new Map();

// TMDB 精确匹配：片名全等（+年份一致），与旧版口径一致，不放宽
async function searchTMDB(title, year = null) {
    const cacheKey = `${title}|${year || ''}`;
    if (tmdbCache.has(cacheKey)) return tmdbCache.get(cacheKey);

    const promise = (async () => {
        const params = { query: title, language: 'zh-CN' };
        if (year) params.first_air_date_year = year;

        const response = await withRetry(`TMDB「${title}」`, () =>
            axios.get(TMDB_BASE_URL, {
                params,
                headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
                timeout: HTTP_TIMEOUT
            })
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

        return {
            id: exactMatch.id,
            type: "tmdb",
            title: exactMatch.name,
            description: exactMatch.overview || '',
            rating: exactMatch.vote_average || 0,
            voteCount: exactMatch.vote_count || 0,
            popularity: exactMatch.popularity || 0,
            releaseDate: exactMatch.first_air_date || '',
            posterPath: exactMatch.poster_path || '',
            backdropPath: exactMatch.backdrop_path || '',
            mediaType: "tv",
            genreTitle: (exactMatch.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean).join(',')
        };
    })();

    tmdbCache.set(cacheKey, promise);
    return promise;
}

async function buildTheater(theater, previous) {
    console.log(`开始获取 ${theater.name} 剧场数据`);
    const { items, pageCount } = await fetchDoulistItems(theater.name, theater.id);
    console.log(`${theater.name}：豆列共 ${items.length} 条，开始匹配 TMDB`);

    // 单条匹配失败只跳过并计数，不再拖垮整个剧场（旧版行为）
    let failed = 0;
    const matched = await mapPool(items, TMDB_CONCURRENCY, async item => {
        const fullTitle = item.year ? `${item.title}(${item.year})` : item.title;
        const { title, year } = parseDoubanTitle(fullTitle);
        try {
            return await searchTMDB(title, year);
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

function readPrevious(outputPath) {
    try {
        return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    } catch {
        return null;
    }
}

async function updateTheaterData() {
    if (!TMDB_API_KEY) {
        throw new Error('TMDB_API_KEY environment variable is required.');
    }

    const outputPath = path.join(__dirname, '..', 'data', 'theater-data.json');
    const previous = readPrevious(outputPath);

    const data = {
        last_updated: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00'),
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

    writeValidatedJson(outputPath, data, {
        label: 'Douban theater collections',
        requiredCollectionGroups: THEATERS.map(theater => ({
            label: theater.name,
            paths: [[theater.name, 'aired'], [theater.name, 'upcoming']]
        }))
    });
}

updateTheaterData().catch(error => {
    console.error('更新失败:', error.stack || error.message);
    process.exitCode = 1;
});
