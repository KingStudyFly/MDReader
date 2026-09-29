(function () {
  'use strict';

  var MATH_START = '\uE000';
  var MATH_END = '\uE001';
  var TOKEN_RE = /\uE000([0-9a-z]+)\uE001/g;
  var LARGE_FILE = 1048576;
  var MATH_PREV_BLOCK = /[A-Za-z0-9$\\]/;

  var els = {};
  var state = {
    theme: 'dark',
    mermaidCount: 0,
    renderSeq: 0,
    chartBlocks: [],
    libs: {},
    libPromises: {},
    loadedScripts: {},
    echartsCharts: [],
    chartResizeTimer: null,
    toastTimer: null,
    progressFile: null,
    progressGuard: false,
    lastAnchor: null,
    scrollTimer: null,
    resizeTimer: null,
    tocEntries: [],
    tocDocHeight: 0,
    tocStale: false,
    tocRaf: 0,
    dbPromise: null
  };

  var RECENT_MAX = 8;
  var PROGRESS_MAX = 50;
  var PROGRESS_KEY = 'mdr-progress';
  var RECENT_KEY = 'mdr-recent';
  var TOPBAR_PROBE = 60;
  // 阅读线取 100px：需明显大于 CSS 的 scroll-padding-top(86px)，否则点击目录跳转后落点稍有取整偏差就退回高亮上一节
  var TOC_PROBE = 100;

  // 图表库按需懒加载：文档里没用到就不下载/不解析（首屏不为 6MB 的库买单）
  var LIBS = {
    mermaid11: 'assets/js/vendor/mermaid11.min.js',
    mermaid9: 'assets/js/vendor/mermaid.min.js',
    echarts: 'assets/js/vendor/echarts.min.js',
    wavedrom: 'assets/js/vendor/wavedrom.min.js',
    fnplot: 'assets/js/vendor/function-plot.min.js'
  };
  var CHART_LANGS = {
    mermaid: 'mermaid',
    echarts: 'echarts',
    chart: 'echarts',
    wavedrom: 'wavedrom',
    wave: 'wavedrom',
    function: 'fnplot',
    'fn-plot': 'fnplot'
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createSlugger() {
    var seen = Object.create(null);
    var decoder = document.createElement('div');
    return function (inlineHtml) {
      decoder.innerHTML = inlineHtml;
      var base = decoder.textContent.toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}\-]/gu, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '') || 'section';
      if (!(base in seen)) { seen[base] = 0; return base; }
      seen[base] += 1;
      return base + '-' + seen[base];
    };
  }

  function countRun(src, i, ch) {
    var run = 0;
    while (i + run < src.length && src.charAt(i + run) === ch) run++;
    return run;
  }

  function findUnescaped(src, needle, from) {
    var k = src.indexOf(needle, from);
    while (k !== -1) {
      var bs = 0;
      var p = k - 1;
      while (p >= 0 && src.charAt(p) === '\\') { bs++; p--; }
      if (bs % 2 === 0) return k;
      k = src.indexOf(needle, k + needle.length);
    }
    return -1;
  }

  function extractMath(src) {
    var store = [];
    var out = '';
    var i = 0;
    var n = src.length;

    function pushMath(tex, display) {
      var idx = store.push({ tex: tex, display: display }) - 1;
      out += MATH_START + idx.toString(36) + MATH_END;
    }

    while (i < n) {
      var c = src.charAt(i);
      var atLineStart = i === 0 || src.charAt(i - 1) === '\n';

      if (atLineStart && (c === '`' || c === '~')) {
        var run = countRun(src, i, c);
        if (run >= 3) {
          var closeRe = new RegExp('\n {0,3}\\' + c + '{' + run + ',}[ \\t]*(?=\\n|$)');
          var cm = closeRe.exec(src.slice(i + run));
          if (cm) {
            var endIdx = i + run + cm.index + cm[0].length;
            out += src.slice(i, endIdx);
            i = endIdx;
          } else {
            out += src.slice(i);
            i = n;
          }
          continue;
        }
      }

      if (c === '\\') {
        out += src.substr(i, 2);
        i += 2;
        continue;
      }

      if (c === '`') {
        var run2 = countRun(src, i, '`');
        if (run2 >= 1) {
          var closeIdx = src.indexOf('`'.repeat(run2), i + run2);
          if (closeIdx !== -1) {
            out += src.slice(i, closeIdx + run2);
            i = closeIdx + run2;
          } else {
            out += c;
            i += 1;
          }
          continue;
        }
      }

      if (c === '$') {
        if (src.charAt(i + 1) === '$') {
          var end = findUnescaped(src, '$$', i + 2);
          if (end !== -1) {
            var inner = src.slice(i + 2, end);
            if (inner.trim()) {
              pushMath(inner, true);
              i = end + 2;
            } else {
              out += '$$';
              i += 2;
            }
          } else {
            out += '$$';
            i += 2;
          }
          continue;
        }
        var prevOk = i === 0 || !MATH_PREV_BLOCK.test(src.charAt(i - 1));
        var nextCh = src.charAt(i + 1);
        if (prevOk && nextCh && !/\s/.test(nextCh) && nextCh !== '$') {
          var k = i + 1;
          var found = -1;
          while (k < n && src.charAt(k) !== '\n') {
            if (src.charAt(k) === '\\') { k += 2; continue; }
            if (src.charAt(k) === '$') {
              if (k > i + 1 && !/[\s]/.test(src.charAt(k - 1))) found = k;
              break;
            }
            k++;
          }
          if (found !== -1) {
            var inlineTex = src.slice(i + 1, found);
            var firstCh = inlineTex.charAt(0);
            var lastCh = inlineTex.charAt(inlineTex.length - 1);
            if (firstCh !== '$' && lastCh !== '$' && !/\s/.test(firstCh) && !/\s/.test(lastCh)) {
              pushMath(inlineTex, false);
              i = found + 1;
              continue;
            }
          }
        }
        out += c;
        i += 1;
        continue;
      }

      out += c;
      i += 1;
    }

    return { text: out, math: store };
  }

  function katexHtml(tex, display) {
    try {
      return window.katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml'
      });
    } catch (e) {
      return '<code>' + escapeHtml(tex) + '</code>';
    }
  }

  function fillMath(rootEl, mathStore) {
    if (!mathStore.length) return;
    var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.indexOf(MATH_START) !== -1) nodes.push(node);
    }
    nodes.forEach(function (tn) {
      var parts = tn.nodeValue.split(TOKEN_RE);
      var fragOut = document.createDocumentFragment();
      for (var p = 0; p < parts.length; p++) {
        if (p % 2 === 0) {
          if (parts[p]) fragOut.appendChild(document.createTextNode(parts[p]));
        } else {
          var entry = mathStore[parseInt(parts[p], 36)];
          var span = document.createElement('span');
          if (entry) {
            span.innerHTML = katexHtml(entry.tex, entry.display);
          } else {
            span.textContent = MATH_START + parts[p] + MATH_END;
          }
          fragOut.appendChild(span);
        }
      }
      tn.parentNode.replaceChild(fragOut, tn);
    });
  }

  function makeRenderer() {
    var slug = createSlugger();

    function asToken(arg, legacyText, legacyLang) {
      if (arg && typeof arg === 'object') return arg;
      return { text: legacyText, lang: legacyLang };
    }

    return {
      code: function (a, legacyText, legacyLang) {
        var t = asToken(a, legacyText, legacyLang);
        var info = String(t.lang || 'text');
        var lang = info.split(/\s+/)[0].toLowerCase();
        return '<div class="codeblock" data-lang="' + escapeHtml(lang) + '" data-info="' + escapeHtml(info) + '">' +
          '<div class="codeblock-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
          '<span class="codeblock-lang">' + escapeHtml(lang) + '</span>' +
          '<button class="codeblock-copy" type="button">复制</button></div>' +
          '<pre><code class="hljs language-' + escapeHtml(lang) + '">' + escapeHtml(t.text || '') + '</code></pre></div>';
      },
      heading: function (a, legacyText, legacyLevel) {
        var depth, inlineHtml;
        if (a && typeof a === 'object') {
          depth = a.depth;
          inlineHtml = this.parser.parseInline(a.tokens);
        } else {
          depth = legacyLevel;
          inlineHtml = legacyText;
        }
        var id = slug(inlineHtml);
        return '<h' + depth + ' id="' + escapeHtml(id) + '">' + inlineHtml + '</h' + depth + '>';
      },
      link: function (a, legacyHref, legacyTitle) {
        var href, title, inlineHtml;
        if (a && typeof a === 'object') {
          href = a.href;
          title = a.title;
          inlineHtml = this.parser.parseInline(a.tokens);
        } else {
          href = legacyHref;
          title = legacyTitle;
          inlineHtml = a;
        }
        var attrs = ' href="' + escapeHtml(href || '') + '"' +
          (title ? ' title="' + escapeHtml(title) + '"' : '');
        if (/^https?:/i.test(href || '')) {
          attrs += ' target="_blank" rel="noopener noreferrer"';
        }
        return '<a' + attrs + '>' + inlineHtml + '</a>';
      },
      image: function (a, legacyHref, legacyTitle, legacyText) {
        var href, title, alt;
        if (a && typeof a === 'object') {
          href = a.href;
          title = a.title;
          alt = a.text || '';
        } else {
          href = legacyHref;
          title = legacyTitle;
          alt = legacyText || '';
        }
        return '<img src="' + escapeHtml(href || '') + '" alt="' + escapeHtml(alt) + '"' +
          (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy" decoding="async">';
      },
      checkbox: function () {
        return '<input type="checkbox" disabled>';
      },
      listitem: function (a) {
        if (typeof a === 'string') {
          return '<li>' + a + '</li>';
        }
        var inner = this.parser.parse(a.tokens, !!a.loose);
        if (a.task) {
          var cb = '<input type="checkbox" disabled' + (a.checked ? ' checked' : '') + '> ';
          if (a.loose) {
            inner = '<p>' + cb + inner.replace(/^<p>/, '');
          } else {
            inner = cb + inner;
          }
          return '<li class="task-item">' + inner + '</li>';
        }
        return '<li>' + inner + '</li>';
      }
    };
  }

  var SANITIZE_CFG = {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_ATTR: ['target', 'rel', 'id', 'loading', 'decoding'],
    FORBID_TAGS: ['style'],
    KEEP_CONTENT: true
  };

  function sanitize(html) {
    return window.DOMPurify.sanitize(html, SANITIZE_CFG);
  }

  function parseMarkdown(src) {
    var extracted = extractMath(src);
    window.marked.use({ gfm: true, breaks: false, renderer: makeRenderer() });
    var clean = sanitize(window.marked.parse(extracted.text));
    var frag = document.createElement('div');
    frag.innerHTML = clean;
    fillMath(frag, extracted.math);
    return sanitize(frag.innerHTML);
  }

  function highlightAndDiagram() {
    var seq = ++state.renderSeq;
    disposeEcharts();
    state.chartBlocks = [];

    els.article.querySelectorAll('pre code').forEach(function (codeEl) {
      var block = codeEl.closest('.codeblock');
      if (!block) return;
      var lang = block.getAttribute('data-lang');
      var kind = CHART_LANGS[lang];
      if (kind) {
        renderChart(kind, block, codeEl.textContent, seq);
        return;
      }
      if (!lang || window.hljs.getLanguage(lang)) {
        try { window.hljs.highlightElement(codeEl); } catch (e) { /* isolated */ }
      }
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('外部资源加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureLib(name) {
    // 用「脚本文件是否已加载」作为判据：mermaid v9/v11 共用 window.mermaid 这个全局名，猜全局会出错
    if (state.loadedScripts[name]) return Promise.resolve();
    if (state.libPromises[name]) return state.libPromises[name];
    var p = loadScript(LIBS[name]).then(function () {
      state.loadedScripts[name] = true;
    }).catch(function (e) {
      delete state.libPromises[name];
      throw e;
    });
    state.libPromises[name] = p;
    return p;
  }

  function chartHost(block, kind) {
    var host = document.createElement('div');
    host.className = 'chart-box';
    host.setAttribute('data-kind', kind);
    var loading = document.createElement('span');
    loading.className = 'chart-loading';
    loading.textContent = '图表渲染中…';
    host.appendChild(loading);
    block.parentNode.replaceChild(host, block);
    return host;
  }

  // 计算图表在文档中的标题面包屑（h1 → … → 最近标题），用于错误报告定位
  function chartSectionPath(block) {
    var blockTop = docOffsetTop(block);
    var hs = els.article.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    var stack = [];
    Array.prototype.forEach.call(hs, function (h) {
      if (docOffsetTop(h) > blockTop) return;
      var level = parseInt(h.tagName.charAt(1), 10);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level: level, text: h.textContent, id: h.id });
    });
    return stack;
  }

  function sectionLabel(stack) {
    if (!stack || !stack.length) return '';
    return stack.map(function (s) {
      var t = s.text;
      if (t.length > 24) t = t.slice(0, 24) + '…';
      return t;
    }).join(' › ');
  }

  function chartFail(host, msg) {
    // 完整错误详情存到 data-err（消息可能含换行），点击错误框时收集全部条目复制
    host.className = 'chart-box chart-error';
    host.setAttribute('data-err', msg || '');
    host.title = '点击复制全部图表错误信息';
    host.innerHTML = '';
    var sec = host.getAttribute('data-sec');
    if (sec) {
      var em = document.createElement('em');
      em.className = 'chart-err-sec';
      var stack = [];
      try { stack = JSON.parse(sec); } catch (e) { /* noop */ }
      em.textContent = '位于「' + sectionLabel(stack) + '」';
      host.appendChild(em);
    }
    var strong = document.createElement('strong');
    strong.textContent = msg;
    host.appendChild(strong);
  }

  var CHART_KIND_LABELS = {
    mermaid: 'Mermaid',
    echarts: 'ECharts',
    wavedrom: 'WaveDrom',
    fnplot: 'function-plot'
  };

  // 收集当前文档里所有图表错误（按出现顺序），返回 { count, text }；无错误返回 null
  function collectChartErrors() {
    var boxes = els.article.querySelectorAll('.chart-error');
    if (!boxes.length) return null;
    var lines = [];
    Array.prototype.forEach.call(boxes, function (b, i) {
      var kind = b.getAttribute('data-kind');
      var label = CHART_KIND_LABELS[kind] || kind || '图表';
      var err = b.getAttribute('data-err') || b.textContent || '未知错误';
      var at = '';
      var sec = b.getAttribute('data-sec');
      if (sec) {
        var stack = [];
        try { stack = JSON.parse(sec); } catch (e) { /* noop */ }
        if (stack.length) at = '（位于「' + sectionLabel(stack) + '」）';
      }
      lines.push('[' + (i + 1) + '] ' + label + ' — ' + err + at);
    });
    var doc = els.docname && els.docname.textContent ? els.docname.textContent : '';
    var header = 'MDReader 图表错误报告（' + lines.length + ' 条）' +
      (doc ? ' · ' + doc : '');
    return { count: lines.length, text: header + '\n\n' + lines.join('\n') };
  }

  function chartInfo(block) {
    var info = (block.getAttribute('data-info') || '').split(/\s+/).slice(1);
    var out = { height: 0, id: '' };
    info.forEach(function (tok) {
      if (/^\d{2,4}$/.test(tok)) out.height = Math.min(1200, Math.max(120, parseInt(tok, 10)));
      else if (tok) out.id = tok;
    });
    return out;
  }

  function chartJob(entry, seq) {
    if (entry.kind === 'echarts') return renderEcharts(entry, seq);
    if (entry.kind === 'wavedrom') return renderWavedrom(entry, seq);
    if (entry.kind === 'fnplot') return renderFnPlot(entry, seq);
    return renderMermaid(entry, seq);
  }

  function renderChart(kind, block, source, seq) {
    // 先记录图表所在标题面包屑，再替换容器——chartHost 会把 block 移出 DOM，
    // 若在替换后计算，detached 节点的 offsetTop 链为 0，位置会算错
    var path = chartSectionPath(block);
    var host = chartHost(block, kind);
    if (path.length) {
      host.setAttribute('data-sec', JSON.stringify(path.map(function (p) {
        return { text: p.text, id: p.id };
      })));
    }
    var opts = chartInfo(block);
    var entry = { kind: kind, host: host, source: source, opts: opts, api: null };
    state.chartBlocks.push(entry);

    chartJob(entry, seq).catch(function (e) {
      if (seq !== state.renderSeq) return;
      chartFail(host, (e && e.message) || '图表渲染失败');
    }).then(function () {
      if (seq === state.renderSeq) scheduleTocUpdate();
    });
  }

  function disposeEcharts() {
    state.echartsCharts.forEach(function (c) {
      try { c.dispose(); } catch (e) { /* isolated */ }
    });
    state.echartsCharts = [];
  }

  function cleanupMermaidTmp(id) {
    // mermaid 失败时会在 body 里留下 d{id} 残片
    var tmp = document.getElementById('d' + id);
    if (tmp && tmp.parentNode) tmp.parentNode.removeChild(tmp);
  }

  function mermaidTheme() {
    return state.theme === 'dark' ? 'dark' : 'neutral';
  }

  function ensureMermaid11() {
    return ensureLib('mermaid11').then(function () {
      if (!state.libs.mermaid11) {
        if (!window.mermaid) throw new Error('Mermaid v11 未就绪');
        state.libs.mermaid11 = window.mermaid;
      }
      state.libs.mermaid11.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // 不启用 suppressErrorRendering：否则语法错误会渲染成"错误占位 SVG"（合法 <svg>），
        // 既无法触发 v9 回退，也无法进入错误框；关掉后错误会正常 reject 走 catch
        theme: mermaidTheme()
      });
      return state.libs.mermaid11;
    });
  }

  function ensureMermaid9() {
    return ensureLib('mermaid9').then(function () {
      // v9 与 v11 共用同一个全局名：v9 脚本执行后 window.mermaid 会被换成 v9 实例
      if (window.mermaid && window.mermaid !== state.libs.mermaid11) {
        state.libs.mermaid9 = window.mermaid;
      }
      if (!state.libs.mermaid9) throw new Error('Mermaid v9 回退库未就绪');
      state.libs.mermaid9.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: mermaidTheme()
      });
      return state.libs.mermaid9;
    });
  }

  // mermaid（v9/v11 皆然）对语法错误不抛异常，而是 resolve 一张错误占位 SVG
  // （aria-roledescription="error"）。返回错误描述字符串；无错误返回 null。
  function mermaidSvgError(svg) {
    if (!/aria-roledescription=["']error["']/.test(svg)) return null;
    var detail = '';
    try {
      var tmp = document.createElement('div');
      tmp.innerHTML = svg;
      var errText = tmp.querySelector('.error-text, .error-icon + text');
      detail = errText ? String(errText.textContent || '').trim().slice(0, 120) : '';
    } catch (e) { /* noop */ }
    return 'Mermaid 语法错误' + (detail ? '：' + detail : '');
  }

  function mermaid11Render(mm, id, text) {
    return Promise.resolve(mm.render(id, text)).then(function (res) {
      var svg = (res && res.svg) || '';
      var err = mermaidSvgError(svg);
      if (err) throw new Error(err);
      return svg;
    });
  }

  function mermaid9Render(mm, id, text) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      try {
        mm.render(id, text, function (svg) {
          settled = true;
          var err = mermaidSvgError(svg || '');
          if (err) { reject(new Error(err)); return; }
          resolve(svg || '');
        });
      } catch (e) {
        reject(e);
        return;
      }
      setTimeout(function () {
        if (!settled) reject(new Error('Mermaid v9 渲染超时'));
      }, 4000);
    });
  }

  function renderMermaid(entry, seq) {
    var id = 'mmd-' + Date.now().toString(36) + '-' + (state.mermaidCount++);
    return ensureMermaid11().then(function (mm) {
      entry.api = mm;
      return mermaid11Render(mm, id, entry.source);
    }).catch(function (err11) {
      cleanupMermaidTmp(id);
      // v11 失败（语法或加载）→ 回退 v9 再试一次
      return ensureMermaid9().then(function (mm9) {
        entry.api = mm9;
        return mermaid9Render(mm9, id + 'b', entry.source);
      }).catch(function (err9) {
        cleanupMermaidTmp(id + 'b');
        throw new Error('Mermaid 渲染失败：' + (err11 && err11.message || err11));
      });
    }).then(function (svg) {
      cleanupMermaidTmp(id);
      if (!svg || svg.indexOf('<svg') === -1) throw new Error('Mermaid 未产出图形');
      entry.host.innerHTML = svg;
    });
  }

  function renderEcharts(entry, seq) {
    return ensureLib('echarts').then(function () {
      if (!window.echarts) throw new Error('ECharts 未就绪');
      var opt;
      try {
        opt = JSON.parse(entry.source);
      } catch (e) {
        throw new Error('ECharts 配置不是合法 JSON：' + e.message);
      }
      var host = entry.host;
      host.innerHTML = '';
      var canvas = document.createElement('div');
      canvas.className = 'chart-canvas';
      canvas.style.height = (entry.opts.height || 400) + 'px';
      host.appendChild(canvas);
      var chart = window.echarts.init(canvas, state.theme === 'dark' ? 'dark' : null, {
        renderer: 'svg'
      });
      if (state.theme === 'dark') opt.backgroundColor = 'transparent';
      if (!opt.textStyle) opt.textStyle = { color: state.theme === 'dark' ? '#d8dde6' : '#33302a' };
      chart.setOption(opt);
      entry.api = chart;
      entry.canvas = canvas;
      state.echartsCharts.push(chart);
    });
  }

  function renderWavedrom(entry, seq) {
    return ensureLib('wavedrom').then(function () {
      if (!window.wavedrom) throw new Error('WaveDrom 未就绪');
      var data = parseLooseObject(entry.source);
      var host = entry.host;
      host.innerHTML = '';
      var fig = document.createElement('div');
      fig.className = 'chart-figure';
      host.appendChild(fig);
      window.wavedrom.renderWaveElement(
        state.mermaidCount++, data, fig, window.wavedrom.waveSkin
      );
      if (!fig.querySelector('svg')) throw new Error('WaveDrom 未产出图形');
    });
  }

  function renderFnPlot(entry, seq) {
    return ensureLib('fnplot').then(function () {
      if (!window.functionPlot) throw new Error('function-plot 未就绪');
      var spec = parseLooseObject(entry.source);
      var host = entry.host;
      var width = Math.max(280, Math.min(host.clientWidth || 640, 900));
      var height = entry.opts.height || 360;
      var data = [];
      (Array.isArray(spec) ? spec : (spec.data || [])).forEach(function (d) {
        if (!d) return;
        var fn = String(d.fn == null ? '' : d.fn);
        if (!isSafeExpression(fn)) return;
        // 只带上显式给出的字段：传 undefined 会覆盖 function-plot 的默认 graphType 导致内部报错
        var datum = { fn: fn };
        if (d.color) datum.color = d.color;
        if (d.graphType) datum.graphType = d.graphType;
        if (d.range) datum.range = d.range;
        data.push(datum);
      });
      if (!data.length) throw new Error('函数图像：未提供可用的 fn 表达式（支持 x、sin、cos、sqrt、pow 等）');
      if (entry.api && entry.api.destroy) {
        try { entry.api.destroy(); } catch (e) { /* isolated */ }
      }
      host.innerHTML = '';
      var fig = document.createElement('div');
      fig.className = 'chart-figure';
      fig.style.width = width + 'px';
      host.appendChild(fig);
      entry.api = window.functionPlot({
        target: fig,
        width: width,
        height: height,
        xAxis: spec.xAxis || { domain: [-6, 6] },
        yAxis: spec.yAxis || { domain: [-4, 8] },
        grid: true,
        data: data
      });
      entry.width = width;
      if (!fig.querySelector('svg')) throw new Error('函数图像未产出图形');
    });
  }

  // function-plot 的表达式会交给其数学求值器解析，这里再做一层白名单，避免文档内容触发意外求值
  var SAFE_CHARS_RE = /^[0-9a-zA-Z_+\-*/^%().,\s]+$/;
  var SAFE_WORDS = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
    'sqrt', 'abs', 'log', 'log10', 'log2', 'exp', 'pow', 'min', 'max', 'floor', 'ceil',
    'round', 'sign', 'PI', 'E', 'x'];

  function isSafeExpression(fn) {
    if (!fn || fn.length > 300) return false;
    if (!SAFE_CHARS_RE.test(fn)) return false;
    var words = fn.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
    return words.every(function (w) { return SAFE_WORDS.indexOf(w) !== -1; });
  }

  // 宽松对象解析：支持 json5 风格（无引号键、单引号、注释、尾逗号），单次扫描、全程不 eval
  function parseLooseObject(text) {
    var src = String(text);
    var out = '';
    var i = 0;
    var n = src.length;
    var quote = null;
    while (i < n) {
      var c = src.charAt(i);
      if (quote) {
        if (c === '\\') { out += src.substr(i, 2); i += 2; continue; }
        if (c === quote) { quote = null; out += '"'; i++; continue; }
        if (quote === "'" && c === '"') { out += '\\"'; i++; continue; }
        if (c === '\n' || c === '\r') { out += ' '; i++; continue; }
        out += c;
        i++;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; out += '"'; i++; continue; }
      // 注释只在字符串之外剔除，避免误伤形如 'a//b' 的字面量
      if (c === '/' && src.charAt(i + 1) === '/') {
        var eol = src.indexOf('\n', i);
        i = eol === -1 ? n : eol;
        continue;
      }
      if (c === '/' && src.charAt(i + 1) === '*') {
        var endc = src.indexOf('*/', i + 2);
        i = endc === -1 ? n : endc + 2;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        var j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(src.charAt(j))) j++;
        var word = src.slice(i, j);
        var k = j;
        while (k < n && /\s/.test(src.charAt(k))) k++;
        if (src.charAt(k) === ':') out += '"' + word + '"';
        else out += word;
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    out = out.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(out);
    } catch (e) {
      throw new Error('配置解析失败：' + e.message);
    }
  }

  function rerenderCharts() {
    if (!state.chartBlocks.length) return;
    var seq = ++state.renderSeq;
    disposeEcharts();
    state.chartBlocks.forEach(function (entry) {
      entry.host.className = 'chart-box';
      entry.host.innerHTML = '<span class="chart-loading">图表重绘中…</span>';
      chartJob(entry, seq).catch(function (e) {
        chartFail(entry.host, (e && e.message) || '图表重绘失败');
      });
    });
  }

  function resizeCharts() {
    state.echartsCharts.forEach(function (c) {
      try { c.resize(); } catch (e) { /* isolated */ }
    });
    state.chartBlocks.forEach(function (entry) {
      if (entry.kind !== 'fnplot' || !entry.api) return;
      var want = Math.max(280, Math.min(entry.host.clientWidth || 640, 900));
      if (Math.abs(want - (entry.width || 0)) < 48) return;
      renderFnPlot(entry, state.renderSeq).catch(function (e) {
        chartFail(entry.host, (e && e.message) || '函数图像重绘失败');
      });
    });
  }

  function docOffsetTop(el) {
    // 用 offsetTop 链而非 getBoundingClientRect：offsetTop 是布局位置，不受 .appear 的 translateY 动画影响
    var y = 0;
    var node = el;
    while (node) {
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return y;
  }

  function measureToc() {
    state.tocEntries.forEach(function (e) {
      e.top = docOffsetTop(e.el);
    });
    state.tocDocHeight = document.documentElement.scrollHeight;
    state.tocStale = false;
  }

  function updateActiveToc() {
    var entries = state.tocEntries;
    if (!entries.length) { setActiveToc(null); return; }
    // 异步内容（Mermaid 重绘、图片加载）会改变布局 → 文档高度变化时重新测量
    if (state.tocStale || document.documentElement.scrollHeight !== state.tocDocHeight) measureToc();
    var line = window.scrollY + TOC_PROBE;
    var lo = 0;
    var hi = entries.length - 1;
    var found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (entries[mid].top <= line) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    setActiveToc(found === -1 ? null : entries[found].id);
  }

  function scheduleTocUpdate() {
    if (state.tocRaf) return;
    state.tocRaf = window.requestAnimationFrame(function () {
      state.tocRaf = 0;
      updateActiveToc();
    });
  }

  function buildToc() {
    var headings = els.article.querySelectorAll('h1[id], h2[id], h3[id]');
    els.toc.innerHTML = '';
    state.tocEntries = [];
    headings.forEach(function (h) {
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      a.className = 'lv' + h.tagName.charAt(1);
      a.setAttribute('data-target', h.id);
      els.toc.appendChild(a);
      state.tocEntries.push({ id: h.id, el: h, top: 0 });
    });
    els.tocCount.textContent = headings.length ? String(headings.length) : '';
    if (!headings.length) return;
    measureToc();
    updateActiveToc();
  }

  function setActiveToc(id) {
    els.toc.querySelectorAll('a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-target') === id);
    });
  }

  function updateStats(text, file) {
    var cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    var latinWords = (text.match(/[A-Za-z0-9]+/g) || []).length;
    var units = cjk + latinWords;
    var minutes = units === 0 ? 0 : Math.max(1, Math.round(units / 350));
    els.docname.textContent = file.name;
    els.docstats.textContent = units === 0 ? '空文档' :
      '约 ' + units.toLocaleString() + ' 字 · ' + (minutes === 0 ? '不到 1 分钟' : '约 ' + minutes + ' 分钟');
    document.title = file.name + ' · MDReader';
  }

  function showToast(msg) {
    if (!els.toast) {
      els.toast = document.createElement('div');
      els.toast.className = 'toast';
      document.body.appendChild(els.toast);
    }
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
    }, 2600);
  }

  function progressKey(file) {
    return (file && file.name || 'document') + '\u0000' + (file && file.size || 0);
  }

  function readProgressMap() {
    try {
      var o = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { return {}; }
  }

  function readProgress(key) {
    var v = readProgressMap()[key];
    if (typeof v === 'number' && isFinite(v)) {
      return { r: Math.min(1, Math.max(0, v)), a: null };
    }
    if (!v || typeof v !== 'object') return null;
    var ratio = (typeof v.r === 'number' && isFinite(v.r)) ? Math.min(1, Math.max(0, v.r)) : null;
    var anchor = null;
    if (v.a && typeof v.a === 'object' && typeof v.a.i === 'number') {
      anchor = {
        i: v.a.i,
        id: typeof v.a.id === 'string' ? v.a.id : '',
        f: (typeof v.a.f === 'number' && isFinite(v.a.f)) ? Math.min(1, Math.max(0, v.a.f)) : 0
      };
    }
    if (ratio === null && !anchor) return null;
    return { r: ratio, a: anchor };
  }

  function saveProgress(file, entry) {
    try {
      var m = readProgressMap();
      m[progressKey(file)] = entry;
      var keys = Object.keys(m);
      if (keys.length > PROGRESS_MAX) {
        keys.slice(0, keys.length - PROGRESS_MAX).forEach(function (k) { delete m[k]; });
      }
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(m));
    } catch (e) { /* noop */ }
  }

  function readRecents() {
    try {
      var raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (r) {
        return r && typeof r.key === 'string' && typeof r.name === 'string';
      });
    } catch (e) { return []; }
  }

  function writeRecents(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* noop */ }
  }

  function relTime(ts) {
    var d = Date.now() - (ts || 0);
    if (d < 60000) return '刚刚';
    var m = Math.floor(d / 60000);
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var days = Math.floor(h / 24);
    if (days < 7) return days + ' 天前';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  function idb() {
    if (state.dbPromise) return state.dbPromise;
    state.dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = window.indexedDB.open('mdr-cache', 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return state.dbPromise;
  }

  function snapshotSave(key, content) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try { tx = db.transaction('docs', 'readwrite'); }
        catch (e) { reject(e); return; }
        tx.objectStore('docs').put(content, key);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () { /* noop */ });
  }

  function snapshotLoad(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx;
        try { tx = db.transaction('docs', 'readonly'); }
        catch (e) { resolve(null); return; }
        var rq = tx.objectStore('docs').get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function recordRecent(file, text) {
    if (!file || !file.name) return;
    var key = progressKey(file);
    var list = readRecents().filter(function (r) { return r.key !== key; });
    list.unshift({ key: key, name: file.name, size: file.size || 0, ts: Date.now() });
    if (list.length > RECENT_MAX) list.length = RECENT_MAX;
    writeRecents(list);
    if (text && text.length <= LARGE_FILE) snapshotSave(key, text);
    renderRecent();
  }

  function removeRecent(key) {
    writeRecents(readRecents().filter(function (r) { return r.key !== key; }));
    renderRecent();
  }

  function openRecent(r) {
    snapshotLoad(r.key).then(function (content) {
      if (typeof content === 'string' && content.length) {
        renderDocument(content, new File([content], r.name, { type: 'text/markdown' }));
      } else {
        removeRecent(r.key);
        showToast('本地缓存已失效，请重新打开原文件');
      }
    });
  }

  function clearRecent() {
    try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* noop */ }
    idb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction('docs', 'readwrite');
          tx.objectStore('docs').clear();
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        } catch (e) { resolve(); }
      });
    }).catch(function () { /* noop */ }).then(function () {
      renderRecent();
      showToast('最近打开已清空');
    });
  }

  function renderRecent() {
    var list = readRecents();
    if (!list.length) { els.wRecent.hidden = true; return; }
    els.wRecent.hidden = false;
    els.recentList.innerHTML = '';
    list.forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#';
      a.textContent = r.name;
      a.title = '打开 ' + r.name;
      li.appendChild(a);
      var time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = relTime(r.ts);
      li.appendChild(time);
      li.addEventListener('click', function (ev) {
        ev.preventDefault();
        openRecent(r);
      });
      els.recentList.appendChild(li);
    });
  }

  function finishProgressGuard() {
    state.progressGuard = false;
  }

  function maxScroll() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  function clampScroll(y) {
    return Math.min(maxScroll(), Math.max(0, y));
  }

  function articleMetrics() {
    var a = els.article;
    return { top: a.getBoundingClientRect().top + window.scrollY, height: a.scrollHeight };
  }

  function anchorFromDom() {
    var kids = els.article.children;
    if (!kids.length) return null;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (r.bottom > TOPBAR_PROBE + 1) {
        var f = r.height > 0 ? (TOPBAR_PROBE - r.top) / r.height : 0;
        return { i: i, id: kids[i].id || '', f: Math.round(Math.min(1, Math.max(0, f)) * 1000) / 1000 };
      }
    }
    var last = kids.length - 1;
    return { i: last, id: kids[last].id || '', f: 1 };
  }

  function anchorElement(anchor) {
    if (!anchor) return null;
    if (anchor.id) {
      var byId = document.getElementById(anchor.id);
      if (byId && els.article.contains(byId)) return byId;
    }
    var kids = els.article.children;
    if (kids[anchor.i]) return kids[anchor.i];
    return null;
  }

  function scrollToAnchor(anchor) {
    var el = anchorElement(anchor);
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var target = clampScroll(Math.round(r.top + window.scrollY + anchor.f * r.height - TOPBAR_PROBE));
    window.scrollTo({ top: target, behavior: 'instant' });
    return true;
  }

  function currentRatio() {
    var m = articleMetrics();
    if (m.height <= 0) return 0;
    return Math.min(1, Math.max(0, (window.scrollY - m.top) / m.height));
  }

  function saveCurrentProgress() {
    if (!state.progressFile || maxScroll() <= 0) return;
    state.lastAnchor = anchorFromDom();
    saveProgress(state.progressFile, { r: currentRatio(), a: state.lastAnchor });
  }

  function scheduleProgressRestore(file) {
    finishProgressGuard();
    var entry = readProgress(progressKey(file));
    if (!entry) return;
    state.progressGuard = true;
    var applied = null;
    function apply() {
      if (applied !== null && Math.abs(window.scrollY - applied) > 48) return;
      var ok = entry.a ? scrollToAnchor(entry.a) : false;
      if (!ok && entry.r !== null) {
        var m = articleMetrics();
        window.scrollTo({ top: clampScroll(Math.round(m.top + entry.r * m.height)), behavior: 'instant' });
        ok = true;
      }
      if (ok) applied = window.scrollY;
      state.lastAnchor = anchorFromDom();
      scheduleTocUpdate();
    }
    setTimeout(apply, 0);
    setTimeout(function () { apply(); finishProgressGuard(); }, 800);
  }

  function handleResize() {
    if (!state.progressFile) return;
    var anchor = state.lastAnchor;
    if (!anchor) { state.lastAnchor = anchorFromDom(); return; }
    state.progressGuard = true;
    scrollToAnchor(anchor);
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(function () {
      scrollToAnchor(anchor);
      state.lastAnchor = anchorFromDom();
      finishProgressGuard();
    }, 160);
  }

  function resetProgressState() {
    finishProgressGuard();
    state.progressFile = null;
    state.lastAnchor = null;
    clearTimeout(state.scrollTimer);
    clearTimeout(state.resizeTimer);
  }


  function openFile(file) {
    if (!file) return;
    var nameOk = /\.(md|markdown|mdx|mdown|txt)$/i.test(file.name);
    if (!nameOk && file.type !== 'text/markdown' && file.type !== 'text/plain') {
      showToast('仅支持 .md / .markdown / .txt 文本文件');
      return;
    }
    if (file.size > LARGE_FILE) {
      showToast('大文档（' + (file.size / 1048576).toFixed(1) + ' MB），渲染可能稍慢');
    }
    file.text().then(function (raw) {
      var text = raw.replace(/^\uFEFF/, '');
      if (!text.trim()) {
        renderEmpty(file);
        return;
      }
      renderDocument(text, file);
    }).catch(function () {
      showToast('文件读取失败，可能不是有效的文本文件');
    });
  }

  function renderEmpty(file) {
    state.renderSeq++;
    resetProgressState();
    els.welcome.hidden = true;
    els.article.hidden = false;
    els.docname.textContent = file.name;
    els.docstats.textContent = '空文档';
    document.title = file.name + ' · MDReader';
    els.article.innerHTML = '<div class="notice"><strong>这是一份空文档</strong><br>文件存在，但没有任何可阅读的内容。</div>';
    els.toc.innerHTML = '';
    els.tocCount.textContent = '';
    state.tocEntries = [];
  }

  // 示例文档等裸对象没有 size 属性 → 进度/最近 key 会退化成 size 0，而 openRecent 恢复时
  // 合成的是真实 File（size=内容字节数），key 失配导致进度读不到。统一在此补齐字节数。
  function ensureFileMeta(file, text) {
    if (file && typeof file.size === 'number') return file;
    var size = 0;
    try { if (text != null) size = new Blob([text]).size; } catch (e) { /* noop */ }
    return { name: file && file.name || 'document.md', size: size, type: 'text/markdown' };
  }

  function renderDocument(text, file) {
    file = ensureFileMeta(file, text);
    var html;
    try {
      html = parseMarkdown(text);
    } catch (e) {
      showToast('文档解析失败：' + e.message);
      return;
    }
    els.welcome.hidden = true;
    els.article.hidden = false;
    els.article.classList.remove('appear');
    void els.article.offsetWidth;
    els.article.classList.add('appear');
    els.article.innerHTML = html;

    highlightAndDiagram();
    buildToc();
    updateStats(text, file);
    recordRecent(file, text);
    state.progressFile = file;
    scheduleProgressRestore(file);
    window.scrollTo({ top: 0, behavior: 'instant' });
    state.lastAnchor = anchorFromDom();
  }

  function forceImagesLoaded() {
    // 懒加载图片未进过视口就没加载，打印时会空白 → 改为 eager 立即触发加载
    els.article.querySelectorAll('img[loading="lazy"]').forEach(function (img) {
      img.loading = 'eager';
    });
  }

  function exportPdf() {
    if (els.article.hidden || !els.article.children.length) {
      showToast('请先打开一份文档');
      return;
    }
    forceImagesLoaded();
    // 浏览器用 document.title 作为默认 PDF 文件名 → 临时换成纯文件名
    var prevTitle = document.title;
    if (state.progressFile && state.progressFile.name) {
      document.title = state.progressFile.name;
    }
    window.print();
    document.title = prevTitle;
  }

  function showWelcome() {
    state.renderSeq++;
    resetProgressState();
    els.article.hidden = true;
    els.article.innerHTML = '';
    els.welcome.hidden = false;
    els.toc.innerHTML = '';
    els.tocCount.textContent = '';
    state.tocEntries = [];
    els.docname.textContent = '未打开文档';
    els.docstats.textContent = '';
    document.title = 'MDReader · Markdown 阅读器';
    renderRecent();
  }

  function applyTheme(theme, animate) {
    state.theme = theme;
    if (animate) {
      document.documentElement.classList.add('theme-x');
      setTimeout(function () {
        document.documentElement.classList.remove('theme-x');
      }, 420);
    }
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('mdr-theme', theme); } catch (e) { /* noop */ }
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(function () { return true; }).catch(function () {
        return fallbackCopy(t);
      });
    }
    return Promise.resolve(fallbackCopy(t));
  }

  function fallbackCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  var DEMO_MD = [
    '# MDReader 示例文档',
    '',
    '> 这份文档展示了阅读器支持的全部语法。拖入你自己的 `.md` 文件，即刻开始阅读。',
    '',
    '## 文本排版',
    '',
    '支持 **粗体**、*斜体*、~~删除线~~、`行内代码`，以及 [外部链接](https://www.w3.org) 的样式。',
    '中文长段落拥有 1.82 倍行高与精心的字距，标题采用衬线字体，营造纸面阅读的氛围。',
    '',
    '### 引用与分隔',
    '',
    '> 「读书忌太少，读义须反复。」—— 阅读器存在的意义，是让内容本身被尊重。',
    '',
    '---',
    '',
    '## 列表与任务',
    '',
    '1. 标准渲染全家桶：GFM 表格、任务清单、代码围栏',
    '2. 数学公式与流程图，无需联网',
    '3. 智能大纲导航',
    '',
    '- [x] 深浅双主题',
    '- [x] 代码高亮与一键复制',
    '- [ ] 打印样式（规划中）',
    '',
    '## 代码高亮',
    '',
    '```javascript',
    'function fib(n) {',
    '  return n <= 1 ? n : fib(n - 1) + fib(n - 2);',
    '}',
    'const seq = Array.from({ length: 10 }, (_, i) => fib(i));',
    'console.log(seq.join(", "));',
    '```',
    '',
    '```python',
    'def quicksort(xs):',
    '    if len(xs) <= 1:',
    '        return xs',
    '    pivot, *rest = xs',
    '    left = quicksort([x for x in rest if x < pivot])',
    '    right = quicksort([x for x in rest if x >= pivot])',
    '    return left + [pivot] + right',
    '```',
    '',
    '价格里的 $ 符号（如 $5 与 $99）不会被误判为公式。',
    '',
    '## 数学公式',
    '',
    '质能方程 $E = mc^2$ 是行内公式的经典示例。块级公式：',
    '',
    '$$',
    '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}',
    '$$',
    '',
    '欧拉恒等式：$e^{i\\pi} + 1 = 0$，被誉为数学中最美的公式。',
    '',
    '## Mermaid 流程图',
    '',
    '```mermaid',
    'flowchart TD',
    '    A([打开 .md 文件]) --> B{文档大小?}',
    '    B -->|小于 1MB| C[直接渲染]',
    '    B -->|更大| D[提示后渲染]',
    '    C --> E[数学公式提取]',
    '    D --> E',
    '    E --> F[安全净化]',
    '    F --> G([开始阅读])',
    '```',
    '',
    '## 更多图表',
    '',
    '### Mermaid 思维导图',
    '',
    '```mermaid',
    'mindmap',
    '  root((MDReader))',
    '    渲染能力',
    '      KaTeX 公式',
    '      Mermaid 图表',
    '      ECharts 统计图',
    '    阅读体验',
    '      双主题',
    '      目录导航',
    '      进度记忆',
    '```',
    '',
    '### Mermaid 柱线混合图（xychart）',
    '',
    '```mermaid',
    'xychart-beta',
    '  title "月度阅读量"',
    '  x-axis ["一月", "二月", "三月", "四月"]',
    '  y-axis "篇" 0 --> 120',
    '  bar [40, 65, 90, 110]',
    '  line [35, 60, 85, 105]',
    '```',
    '',
    '### ECharts 双轴组合图（可交互）',
    '',
    '```echarts 380',
    '{',
    '  "tooltip": { "trigger": "axis" },',
    '  "legend": { "data": ["营收", "增长率"] },',
    '  "grid": { "left": 60, "right": 60, "top": 56, "bottom": 44, "containLabel": true },',
    '  "xAxis": { "type": "category", "data": ["一月", "二月", "三月", "四月", "五月"] },',
    '  "yAxis": [',
    '    { "type": "value", "name": "万元" },',
    '    { "type": "value", "name": "增长率", "axisLabel": { "formatter": "{value}%" } }',
    '  ],',
    '  "series": [',
    '    { "name": "营收", "type": "bar", "data": [120, 180, 150, 220, 260] },',
    '    { "name": "增长率", "type": "line", "yAxisIndex": 1, "smooth": true, "data": [12, 50, -17, 47, 18] }',
    '  ]',
    '}',
    '```',
    '',
    '### 数字时序波形（WaveDrom）',
    '',
    '```wavedrom',
    '{',
    "  signal: [",
    "    { name: '时钟', wave: 'p....' },",
    "    { name: '数据', wave: 'x3.x5', data: ['读', '写'] },",
    "    { name: '使能', wave: '0.1.0' }",
    '  ],',
    "  head: { text: '总线读写时序' }",
    '}',
    '```',
    '',
    '### 函数图像',
    '',
    '```function 340',
    '{',
    '  data: [',
    '    { fn: "sin(x)", color: "#ff7a45" },',
    '    { fn: "x^2/6 - 1", color: "#58c48a" }',
    '  ],',
    '  xAxis: { domain: [-6, 6] },',
    '  yAxis: { domain: [-3, 5] }',
    '}',
    '```',
    '',
    '## 表格',
    '',
    '| 特性 | 状态 | 说明 |',
    '| --- | --- | --- |',
    '| 拖拽打开 | ✅ | 拖入即读 |',
    '| KaTeX | ✅ | 行内与块级 |',
    '| Mermaid | ✅ | 随主题重绘 |',
    '',
    '## 图片',
    '',
    '![山间晨雾](https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=misty%20mountain%20valley%20at%20dawn%2C%20soft%20warm%20light%2C%20minimalist%20editorial%20photography&image_size=landscape_16_9)',
    '',
    '> 点击任意图片可放大查看。祝阅读愉快。'
  ].join('\n');

  function bindEvents() {
    els.btnOpen.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      openFile(els.fileInput.files[0]);
      els.fileInput.value = '';
    });
    els.fileInputDz.addEventListener('change', function () {
      openFile(els.fileInputDz.files[0]);
      els.fileInputDz.value = '';
    });

    els.btnDemo.addEventListener('click', function () {
      renderDocument(DEMO_MD, { name: '示例文档.md' });
    });

    els.recentClear.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      clearRecent();
    });

    window.addEventListener('scroll', function () {
      if (state.progressGuard || !state.progressFile) return;
      clearTimeout(state.scrollTimer);
      state.scrollTimer = setTimeout(saveCurrentProgress, 350);
    }, { passive: true });

    // 目录高亮：每帧最多算一次，与上面的防抖保存相互独立
    window.addEventListener('scroll', scheduleTocUpdate, { passive: true });

    window.addEventListener('resize', function () {
      state.tocStale = true;
      scheduleTocUpdate();
      handleResize();
      clearTimeout(state.chartResizeTimer);
      state.chartResizeTimer = setTimeout(resizeCharts, 180);
    });

    els.brandHome.addEventListener('click', function (ev) {
      ev.preventDefault();
      showWelcome();
    });

    els.btnTheme.addEventListener('click', function () {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark', true);
      rerenderCharts();
    });

    els.btnPrint.addEventListener('click', exportPdf);

    // 用户直接按 Ctrl/Cmd+P 也走同一条链路（保证图片加载与文件名）
    window.addEventListener('beforeprint', forceImagesLoaded);

    document.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') {
        ev.preventDefault();
        els.fileInput.click();
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'p') {
        ev.preventDefault();
        exportPdf();
      }
      if (ev.key === 'Escape') {
        els.lightbox.classList.remove('show');
        els.lightbox.setAttribute('aria-hidden', 'true');
      }
    });

    var dragDepth = 0;
    window.addEventListener('dragenter', function (ev) {
      ev.preventDefault();
      dragDepth++;
      els.dropOverlay.classList.add('show');
    });
    window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    window.addEventListener('dragleave', function (ev) {
      ev.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) els.dropOverlay.classList.remove('show');
    });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      dragDepth = 0;
      els.dropOverlay.classList.remove('show');
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (!files || !files.length) return;
      var picked = null;
      for (var i = 0; i < files.length; i++) {
        if (/\.(md|markdown|mdx|mdown|txt)$/i.test(files[i].name)) { picked = files[i]; break; }
      }
      openFile(picked || files[0]);
    });

    els.article.addEventListener('click', function (ev) {
      var copyBtn = ev.target.closest('.codeblock-copy');
      if (copyBtn) {
        var block = copyBtn.closest('.codeblock');
        var code = block && block.querySelector('pre code');
        if (code) {
          copyText(code.textContent).then(function (ok) {
            copyBtn.classList.add('copied');
            copyBtn.textContent = ok ? '✓ 已复制' : '复制失败';
            setTimeout(function () {
              copyBtn.classList.remove('copied');
              copyBtn.textContent = '复制';
            }, 1600);
          });
        }
        return;
      }
      // 点击任一图表错误框 → 复制当前文档的全部错误信息
      var errBox = ev.target.closest('.chart-error');
      if (errBox) {
        var report = collectChartErrors();
        if (report) {
          copyText(report.text).then(function (ok) {
            showToast(ok ? '已复制 ' + report.count + ' 条图表错误' : '复制失败');
          });
        }
        return;
      }
      var img = ev.target.closest('img');
      if (img && img.src) {
        els.lightboxImg.src = img.src;
        els.lightboxCap.textContent = img.alt || '';
        els.lightbox.classList.add('show');
        els.lightbox.setAttribute('aria-hidden', 'false');
      }
    });

    els.lightbox.addEventListener('click', function () {
      els.lightbox.classList.remove('show');
      els.lightbox.setAttribute('aria-hidden', 'true');
    });
  }

  function init() {
    els.article = $('article');
    els.welcome = $('welcome');
    els.toc = $('toc');
    els.tocCount = $('tocCount');
    els.docname = $('docname');
    els.docstats = $('docstats');
    els.fileInput = $('fileInput');
    els.fileInputDz = $('fileInputDz');
    els.btnOpen = $('btnOpen');
    els.btnDemo = $('btnDemo');
    els.btnTheme = $('btnTheme');
    els.btnPrint = $('btnPrint');
    els.brandHome = $('brandHome');
    els.wRecent = $('wRecent');
    els.recentList = $('recentList');
    els.recentClear = $('recentClear');
    els.dropOverlay = $('dropOverlay');
    els.lightbox = $('lightbox');
    els.lightboxImg = $('lightboxImg');
    els.lightboxCap = $('lightboxCap');

    var saved = null;
    try { saved = localStorage.getItem('mdr-theme'); } catch (e) { /* noop */ }
    applyTheme(saved === 'light' ? 'light' : 'dark', false);

    bindEvents();
    showWelcome();

    if (/[?&]auto=1(?!\d)/.test(location.search) &&
        window.__MD_PAYLOAD__ && typeof window.__MD_PAYLOAD__.content === 'string') {
      openFile(new File([window.__MD_PAYLOAD__.content],
        window.__MD_PAYLOAD__.name || 'document.md', { type: 'text/markdown' }));
      window.__MD_PAYLOAD__ = null;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
