/* lnreader-to-mangayomi preamble v1
   Added so the extension can clear Cloudflare on its own (works on both the
   stock and patched app; dormant whenever the app resolves requests first).

   Required user input (stock app): the "FlareSolverr / Byparr URL" field in
   this extension's settings. For a compatible solver see
   github.com/FlareSolverr/FlareSolverr ("http://<host>:8191/v1"). */
const LNREADER_FLARESOLVERR_KEY = 'lnreader_flaresolverr_url';

function lnreaderProxyUrl() {
  try {
    if (typeof SharedPreferences === 'function') {
      return String(new SharedPreferences().getString(LNREADER_FLARESOLVERR_KEY, '') || '');
    }
  } catch (e) {
    // Preference store unavailable (e.g. verification sandbox): fall through.
  }
  return '';
}

function looksLikeCloudflareBlock(res) {
  if (!res) return false;
  const status = res.statusCode == null ? res.status : res.statusCode;
  const code = Number(status);
  if (code !== 403 && code !== 503) return false;
  const headers = res.headers || {};
  const lower = {};
  for (const key of Object.keys(headers)) {
    lower[String(key).toLowerCase()] = String(headers[key]).toLowerCase();
  }
  if (lower['cf-mitigated'] === 'challenge') return true;
  if ((lower['server'] || '').indexOf('cloudflare') === -1) return false;
  const body = typeof res.body === 'string' ? res.body.toLowerCase() : '';
  const markers = [
    'just a moment',
    'cf-browser-verification',
    'challenges.cloudflare.com',
    'cf_chl_opt',
  ];
  return markers.some((m) => body.indexOf(m) !== -1);
}

function proxiedResponse(base, solution) {
  const html = solution.response;
  const status = Number(solution.status == null ? 200 : solution.status);
  return {
    statusCode: status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    isRedirect: false,
    persistentConnection: false,
    reasonPhrase: 'proxy-transport',
    body: html,
    url: (base && base.request && base.request.url) || (base && base.url) || '',
    request: (base && base.request) || null,
  };
}

class SelfSolveClient extends Client {
  async selfSolve(url, method, body) {
    const proxyUrl = lnreaderProxyUrl();
    if (!proxyUrl) return null;
    try {
      const cmd = {
        cmd: method === 'POST' ? 'request.post' : 'request.get',
        url: url,
        maxTimeout: 60000,
      };
      if (method === 'POST' && body != null) {
        cmd.postData = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await super.post(proxyUrl, { 'content-type': 'application/json' }, cmd);
      const outer = typeof res === 'string' ? JSON.parse(res) : res;
      if (!outer || outer.statusCode !== 200) return null;
      const payload = typeof outer.body === 'string' ? JSON.parse(outer.body) : null;
      if (!payload || payload.status !== 'ok' || !payload.solution) return null;
      const solution = payload.solution;
      const status = Number(solution.status == null ? 0 : solution.status);
      const html = solution.response;
      if (!(status >= 200 && status < 300) || typeof html !== 'string' || html.length === 0) {
        return null;
      }
      return solution;
    } catch (e) {
      return null;
    }
  }
  async get(url, headers) {
    const res = await super.get(url, headers);
    if (!looksLikeCloudflareBlock(res)) return res;
    const solution = await this.selfSolve(url, 'GET');
    return solution ? proxiedResponse(res, solution) : res;
  }
  async post(url, headers, body) {
    const res = await super.post(url, headers, body);
    if (!looksLikeCloudflareBlock(res)) return res;
    const solution = await this.selfSolve(url, 'POST', body);
    return solution ? proxiedResponse(res, solution) : res;
  }
}

class PreambleMProvider extends MProvider {
  getSourcePreferences() {
    return [
      {
        key: LNREADER_FLARESOLVERR_KEY,
        title: 'FlareSolverr / Byparr URL',
        summary:
          'Used only when this site is Cloudflare-protected. Example: http://localhost:8191/v1',
        editTextPreference: {
          title: 'FlareSolverr / Byparr URL',
          summary:
            "Proxy provides the page when Cloudflare blocks the extension. Leave empty to rely on the app's own resolver.",
          value: '',
        },
      },
    ];
  }
}
const STATUS_MAP = {
  'on-going': 0,
  ongoing: 0,
  completed: 1,
  hiatus: 2,
  'on-hold': 3,
  dropped: 3,
  cancelled: 3,
};

class DefaultExtension extends PreambleMProvider {
  constructor() {
    super();
    this.client = new SelfSolveClient();
    this.site = 'https://fenrirealm.com';
  }

  parseNovelFromApi(apiData) {
    return {
      name: apiData.title,
      link: this.site + '/' + apiData.slug,
      imageUrl: apiData.cover ? this.site + '/' + apiData.cover : null,
      description: apiData.description || null,
    };
  }

  /**
   * Filters state is not used by search/popular/latest in this plugin's LNReader
   * counterpart (searchNovels ignores filters; popular uses defaults), so we
   * replicate the default filter values here.
   */
  seriesListUrl(page, sort) {
    // Mirrors `new URLSearchParams({ page, per_page: '20', sort })` + appended
    // statuses[]/genres[] params (brackets encoded as %5B%5D).
    const params = ['page=' + page, 'per_page=20', 'sort=' + sort];
    const statusValue = '';
    if (statusValue) params.push('statuses%5B%5D=' + encodeURIComponent(statusValue));
    const genres = [];
    for (const genre of genres) params.push('genres%5B%5D=' + encodeURIComponent(genre));
    return this.site + '/api/new/v2/series?' + params.join('&');
  }

  async getPopular(page) {
    const res = await this.client.get(this.seriesListUrl(page, 'popular'));
    const body = JSON.parse(res.body);
    const list = (body.data || []).map(item => this.parseNovelFromApi(item));
    return { list: list, hasNextPage: list.length >= 20 };
  }

  async getLatestUpdates(page) {
    const res = await this.client.get(this.seriesListUrl(page, 'latest'));
    const body = JSON.parse(res.body);
    const list = (body.data || []).map(item => this.parseNovelFromApi(item));
    return { list: list, hasNextPage: list.length >= 20 };
  }

  async search(query, page, filters) {
    const searchUrl =
      this.site +
      '/api/series/filter?page=' +
      page +
      '&per_page=20&search=' +
      encodeURIComponent(query);
    let res = await this.client.get(searchUrl);
    let body = JSON.parse(res.body);

    if (page === 1 && (!body.data || body.data.length === 0)) {
      const words = query.split(' ');
      const fallbackTerm = words.find(word => word.length > 3) || words[0];
      if (fallbackTerm && fallbackTerm !== query) {
        const fallbackUrl =
          this.site +
          '/api/series/filter?page=' +
          page +
          '&per_page=20&search=' +
          encodeURIComponent(fallbackTerm);
        res = await this.client.get(fallbackUrl);
        body = JSON.parse(res.body);
      }
    }

    const list = (body.data || []).map(item => this.parseNovelFromApi(item));
    return { list: list, hasNextPage: list.length >= 20 };
  }

  novelSlugFromUrl(url) {
    let path = url.startsWith(this.site) ? url.slice(this.site.length) : url;
    if (path.startsWith('/series/')) path = path.slice('/series/'.length);
    return path.replace(/^\//, '').replace(/\/+$/, '');
  }

  async getDetail(url) {
    const novelPath = this.novelSlugFromUrl(url);

    let chaptersRes = await this.client.get(
      this.site + '/api/new/v2/series/' + novelPath + '/chapters',
    );
    let cleanNovelPath = novelPath;
    const statusOf = res => {
      const code = res && res.statusCode != null ? Number(res.statusCode) : 0;
      return code >= 200 && code < 300;
    };

    if (!statusOf(chaptersRes)) {
      const slugMatch = novelPath.match(/^\d+-(.+)$/);
      const searchSlug = slugMatch ? slugMatch[1] : novelPath;
      chaptersRes = await this.client.get(
        this.site + '/api/new/v2/series/' + searchSlug + '/chapters',
      );
      cleanNovelPath = searchSlug;

      if (!statusOf(chaptersRes)) {
        const words = searchSlug.replace(/-/g, ' ').split(' ');
        const searchStr = words.find(word => word.length > 3) || words[0];
        const searchRes = await this.client.get(
          this.site +
            '/api/series/filter?page=1&per_page=20&search=' +
            encodeURIComponent(searchStr),
        );
        const searchData = JSON.parse(searchRes.body);
        if (searchData.data && searchData.data.length > 0) {
          cleanNovelPath = searchData.data[0].slug;
          chaptersRes = await this.client.get(
            this.site + '/api/new/v2/series/' + cleanNovelPath + '/chapters',
          );
        }
      }

      if (!statusOf(chaptersRes)) {
        throw new Error(
          'Novel not found. It may have been removed or its URL changed significantly.',
        );
      }
    }

    const seriesRes = await this.client.get(
      this.site + '/api/new/v2/series/' + cleanNovelPath,
    );
    const seriesData = JSON.parse(seriesRes.body);

    let description = seriesData.description || '';
    if (description) {
      description = description
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '');
      description = description
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n\n')
        .trim();
    }

    const chapterJson = JSON.parse(chaptersRes.body);

    const chapters = chapterJson
      .map(chapter => {
        const group = chapter.group || null;
        const path =
          novelPath +
          (group && group.index != null ? '/' + group.slug : '') +
          '/' +
          (chapter.slug || 'chapter-' + chapter.number) +
          '~~' +
          chapter.id;
        const created = chapter.created_at
          ? new Date(chapter.created_at).getTime()
          : NaN;
        let name =
          (chapter.locked && chapter.locked.price ? '🔒 ' : '') +
          (group && group.index != null ? 'Vol ' + group.index + ' ' : '') +
          'Chapter ' +
          chapter.number;
        if (
          chapter.title &&
          chapter.title.trim() != 'Chapter ' + chapter.number
        ) {
          name +=
            ' - ' + chapter.title.replace(/^chapter [0-9]+ . /i, '');
        }
        return {
          name: name,
          url: this.site + '/' + path,
          dateUpload: isNaN(created) ? '' : String(created),
          __num: chapter.number + ((group && group.index) || 0) * 10000,
        };
      })
      .sort((a, b) => a.__num - b.__num)
      .map(chapter => ({
        name: chapter.name,
        url: chapter.url,
        dateUpload: chapter.dateUpload,
      }));

    const rawStatus = (seriesData.status || '').toLowerCase();

    return {
      name: seriesData.title || '',
      imageUrl: seriesData.cover ? this.site + '/' + seriesData.cover : null,
      description: description,
      author:
        (seriesData.user && (seriesData.user.name || seriesData.user.username)) ||
        '',
      artist: '',
      status: STATUS_MAP[rawStatus] !== undefined ? STATUS_MAP[rawStatus] : 5,
      genre: (seriesData.genres || []).map(item => item.name),
      chapters: chapters,
    };
  }

  /**
   * Legacy TipTap AST renderer — identical mark handling to the LNReader
   * plugin (underline/strike/link included in this variant).
   */
  renderTipTapContent(docJson, fullMarks) {
    return (docJson.content || [])
      .map(node => {
        if (node.type === 'paragraph') {
          const innerHtml =
            (node.content || [])
              .map(child => {
                if (child.type === 'text') {
                  let text = child.text;
                  if (child.marks) {
                    for (const mark of child.marks) {
                      if (mark.type === 'bold') text = '<b>' + text + '</b>';
                      if (mark.type === 'italic') text = '<i>' + text + '</i>';
                      if (fullMarks) {
                        if (mark.type === 'underline')
                          text = '<u>' + text + '</u>';
                        if (mark.type === 'strike')
                          text = '<strike>' + text + '</strike>';
                        if (mark.type === 'link')
                          text =
                            '<a href="' +
                            (mark.attrs && mark.attrs.href != null
                              ? mark.attrs.href
                              : '') +
                            '">' +
                            text +
                            '</a>';
                      }
                    }
                  }
                  return text;
                }
                if (child.type === 'hardBreak') return '<br>';
                return '';
              })
              .join('') || '';
          return '<p>' + innerHtml + '</p>';
        }
        if (node.type === 'heading') {
          const level =
            node.attrs && node.attrs.level ? node.attrs.level : 1;
          const innerHtml =
            (node.content || []).map(child => child.text).join('') || '';
          return '<h' + level + '>' + innerHtml + '</h' + level + '>';
        }
        return '';
      })
      .join('\n');
  }

  htmlCleaner(input) {
    let html = input;

    // 1. Scrambled hidden divs + hidden paragraphs
    html = html.replace(
      /<(div|p)\b[^>]*aria-hidden=(?:"true"|'true'|true\b)[^>]*>[\s\S]*?<\/\1>/gi,
      '',
    );
    // 2. Reader attributions / copy reference blocks
    html = html.replace(
      /<(\w+)\b[^>]*class\s*=\s*["'][^"']*reader-attribution[^>]*>[\s\S]*?<\/\1>/gi,
      '',
    );
    // 3. data-fr-attr watermark elements
    html = html.replace(
      /<(\w+)\b[^>]*\sdata-fr-attr[\s=>][^>]*>[\s\S]*?<\/\1>/gi,
      '',
    );
    // 4. Inline styles
    html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

    // 5. Text nodes with copy references / bookmarks
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      html = html.replace(
        /<(p|div|span|small)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
        (whole, tag, attrs, inner) => {
          const text =
            inner
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/g, ' ')
              .trim() || '';
          if (
            text.startsWith('Copy reference:') ||
            text.startsWith('Bookmark:')
          ) {
            changed = true;
            return '';
          }
          return whole;
        },
      );
      if (!changed) break;
    }

    return html;
  }

  async getHtmlContent(name, url) {
    const chapterPath = this.novelSlugFromUrl(url);
    const segments = chapterPath.split('~~');
    const chapterId = segments[1];

    if (chapterId) {
      const res = await this.client.get(
        this.site + '/api/new/v2/chapters/' + chapterId,
      );
      let json;
      try {
        json = JSON.parse(res.body);
      } catch (error) {
        json = null;
      }
      const content = json && json.content ? json.content : null;

      if (content) {
        try {
          const parsedContent = JSON.parse(content);
          if (
            parsedContent.type === 'doc' ||
            parsedContent.type === 'systemWindow'
          ) {
            return this.renderTipTapContent(parsedContent, true);
          }
        } catch (error) {
          try {
            return this.htmlCleaner(content) || content;
          } catch (error2) {
            return content;
          }
        }
        // Parsed but unexpected doc type
        return content;
      }
    }

    // Fallback: scrape the series page reader area
    const result = await this.client.get(
      this.site + '/series/' + segments[0],
    );
    const doc = new Document(result.body);

    const paragraphs = doc.select(
      '.reader-area p, div.content-area p, [id^="reader-area"] p',
    );

    const parts = [];
    for (const element of paragraphs) {
      let covered = false;
      let current = element;
      while (current && current.localName) {
        const className = ' ' + current.className + ' ';
        if (
          (current.localName === 'div' || current.localName === 'p') &&
          current.attr('aria-hidden') === 'true'
        ) {
          covered = true;
          break;
        }
        if (current.hasAttr('data-fr-attr')) {
          covered = true;
          break;
        }
        if (className.includes(' reader-attribution ')) {
          covered = true;
          break;
        }
        current = current.parent;
      }
      if (element.attr('aria-hidden') === 'true') covered = true;
      if (covered) continue;

      const innerHtml = element.innerHtml.trim();
      if (!innerHtml) continue;

      let textOnly = innerHtml
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
      if (
        textOnly.startsWith('Copy reference:') ||
        textOnly.startsWith('Bookmark:')
      ) {
        continue;
      }

      parts.push('<p>' + innerHtml + '</p>');
    }

    if (parts.length > 0) {
      return parts.join('\n');
    }

    // SvelteKit JSON fallback
    try {
      const jsonRes = await this.client.get(
        this.site +
          '/series/' +
          segments[0] +
          '/__data.json?x-sveltekit-invalidated=001',
      );
      const json = JSON.parse(jsonRes.body);
      const nodes = json.nodes || [];
      const dataNode = nodes.filter(node => node.type === 'data')[0];
      const data = dataNode ? dataNode.data : null;
      if (data) {
        let contentStr = null;
        for (const item of data) {
          if (typeof item === 'string' && item.includes('{"type":"doc"')) {
            contentStr = item;
            break;
          }
        }
        if (contentStr) {
          const contentJson = JSON.parse(contentStr);
          if (contentJson.type === 'doc') {
            return this.renderTipTapContent(contentJson, false);
          }
        }
      }
    } catch (error) {
      // ignore
    }

    return '';
  }

  cleanHtmlContent(html) {
    return html;
  }

  getFilterList() {
    return [
  {
    "type": "picker",
    "name": "status",
    "state": 0,
    "values": [
      {
        "type_name": "SelectOption",
        "name": "All",
        "value": ""
      },
      {
        "type_name": "SelectOption",
        "name": "Ongoing",
        "value": "on-going"
      },
      {
        "type_name": "SelectOption",
        "name": "Completed",
        "value": "completed"
      },
      {
        "type_name": "SelectOption",
        "name": "Hiatus",
        "value": "hiatus"
      },
      {
        "type_name": "SelectOption",
        "name": "On Hold",
        "value": "on-hold"
      },
      {
        "type_name": "SelectOption",
        "name": "Dropped",
        "value": "dropped"
      }
    ],
    "type_name": "SelectFilter"
  },
  {
    "type": "picker",
    "name": "sort",
    "state": 0,
    "values": [
      {
        "type_name": "SelectOption",
        "name": "Popular",
        "value": "popular"
      },
      {
        "type_name": "SelectOption",
        "name": "Latest",
        "value": "latest"
      },
      {
        "type_name": "SelectOption",
        "name": "Updated",
        "value": "updated"
      }
    ],
    "type_name": "SelectFilter"
  },
  {
    "type": "group",
    "name": "genres",
    "state": [
      {
        "type_name": "CheckBox",
        "name": "Action",
        "value": "1",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Adult",
        "value": "2",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Adventure",
        "value": "3",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Comedy",
        "value": "4",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Drama",
        "value": "5",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Ecchi",
        "value": "6",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Fantasy",
        "value": "7",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Gender Bender",
        "value": "8",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Harem",
        "value": "9",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Historical",
        "value": "10",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Horror",
        "value": "11",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Josei",
        "value": "12",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Martial Arts",
        "value": "13",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Mature",
        "value": "14",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Mecha",
        "value": "15",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Mystery",
        "value": "16",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Psychological",
        "value": "17",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Romance",
        "value": "18",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "School Life",
        "value": "19",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Sci-fi",
        "value": "20",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Seinen",
        "value": "21",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Shoujo",
        "value": "22",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Shoujo Ai",
        "value": "23",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Shounen",
        "value": "24",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Shounen Ai",
        "value": "25",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Slice of Life",
        "value": "26",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Smut",
        "value": "27",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Sports",
        "value": "28",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Supernatural",
        "value": "29",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Tragedy",
        "value": "30",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Wuxia",
        "value": "31",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Xianxia",
        "value": "32",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Xuanhuan",
        "value": "33",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Yaoi",
        "value": "34",
        "state": false
      },
      {
        "type_name": "CheckBox",
        "name": "Yuri",
        "value": "35",
        "state": false
      }
    ],
    "type_name": "GroupFilter"
  }
];
  }

  getSourcePreferences() {
    return [];
  }
}
