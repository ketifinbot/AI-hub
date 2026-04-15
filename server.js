const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_DIR = __dirname;
function resolveWritableDataDir() {
  const configured = process.env.DATA_DIR;
  const renderDisk = process.env.RENDER_DISK_PATH ? path.join(process.env.RENDER_DISK_PATH, 'data') : '';
  const localDefault = path.join(APP_DIR, 'data');
  const tempDefault = path.join(os.tmpdir(), 'finbot-hub-data');
  const candidates = [configured, renderDisk, localDefault, tempDefault]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {
      console.warn(`Skipping non-writable data dir: ${dir} (${e.message})`);
    }
  }

  throw new Error('No writable data directory available');
}

const DATA_DIR = resolveWritableDataDir();
const uploadsDir = path.join(DATA_DIR, 'uploads');
const textsDir = path.join(DATA_DIR, 'texts');
const keysPath = path.join(DATA_DIR, 'api-keys.json');
const CHAT_HISTORY_LIMIT = 8;
const DEFAULT_KNOWLEDGE_MAX_CHARS = 18000;
const MAX_KNOWLEDGE_MAX_CHARS = 60000;
const ANTHROPIC_TIMEOUT_MS = 65000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok' });
});

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function migrateLegacyFile(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return;
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function migrateLegacyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  ensureDir(targetDir);
  fs.readdirSync(sourceDir).forEach((fileName) => {
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(targetDir, fileName);
    if (!fs.statSync(sourcePath).isFile() || fs.existsSync(targetPath)) return;
    fs.copyFileSync(sourcePath, targetPath);
  });
}

ensureDir(DATA_DIR);
ensureDir(uploadsDir);
ensureDir(textsDir);
migrateLegacyFile(path.join(APP_DIR, 'api-keys.json'), keysPath);
migrateLegacyDirectory(path.join(APP_DIR, 'uploads'), uploadsDir);
migrateLegacyDirectory(path.join(APP_DIR, 'texts'), textsDir);

const allowedKeyIds = ['ant', 'oai', 'hj', 'cu', 'sl', 'gd', 'zh'];
let keyStore = {
  ant: process.env.ANTHROPIC_API_KEY || '',
  oai: '',
  hj: '',
  cu: '',
  sl: '',
  gd: '',
  zh: ''
};

if (fs.existsSync(keysPath)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    keyStore = { ...keyStore, ...loaded };
  } catch (e) {
    console.error('Failed to load api-keys.json:', e.message);
  }
}

function persistKeys() {
  fs.writeFileSync(keysPath, JSON.stringify(keyStore, null, 2), 'utf8');
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeTitleForFile(title) {
  return String(title || 'article')
    .toLowerCase()
    .replace(/[^a-z0-9\u0590-\u05ff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'article';
}

function extractCollection(payload, preferredKey) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (preferredKey && Array.isArray(payload[preferredKey])) return payload[preferredKey];
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && preferredKey && Array.isArray(payload.data[preferredKey])) return payload.data[preferredKey];
  if (payload.result && preferredKey && Array.isArray(payload.result[preferredKey])) return payload.result[preferredKey];
  return [];
}

function readKnowledgeEntries() {
  if (!fs.existsSync(textsDir)) return [];
  return fs.readdirSync(textsDir)
    .filter((fileName) => fileName.toLowerCase().endsWith('.txt'))
    .map((fileName) => {
      const filePath = path.join(textsDir, fileName);
      return {
        fileName,
        text: fs.readFileSync(filePath, 'utf8')
      };
    })
    .filter((entry) => entry.text && entry.text.trim());
}

function normalizeSearchTerms(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0590-\u05ff\s]+/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function scoreKnowledgeEntry(entryText, terms) {
  if (!terms.length) return 0;
  const haystack = String(entryText || '').toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function selectRelevantKnowledge(query, maxChars = DEFAULT_KNOWLEDGE_MAX_CHARS) {
  const entries = readKnowledgeEntries();
  if (!entries.length) return '';

  const safeMaxChars = Math.max(1000, Math.min(Number(maxChars) || DEFAULT_KNOWLEDGE_MAX_CHARS, MAX_KNOWLEDGE_MAX_CHARS));
  const terms = normalizeSearchTerms(query);
  const rankedEntries = entries
    .map((entry) => ({ ...entry, score: scoreKnowledgeEntry(entry.text, terms) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.text.length - left.text.length;
    });

  const picked = [];
  let usedChars = 0;

  rankedEntries.forEach((entry) => {
    if (usedChars >= safeMaxChars) return;
    if (terms.length && entry.score === 0 && picked.length > 0) return;

    const remaining = safeMaxChars - usedChars;
    if (remaining <= 0) return;

    const text = entry.text.length > remaining ? entry.text.slice(0, remaining) : entry.text;
    if (!text.trim()) return;

    picked.push(text.trim());
    usedChars += text.length + 2;
  });

  if (!picked.length) {
    return entries
      .map((entry) => entry.text)
      .join('\n\n')
      .slice(0, safeMaxChars)
      .trim();
  }

  return picked.join('\n\n').trim();
}

function resolveHelpjuiceArticleUrl(domain, article) {
  const direct = article.url || article.public_url || article.permalink || article.link || article.path;
  if (direct && /^https?:\/\//i.test(String(direct))) return String(direct);
  if (direct) return `https://${domain}/${String(direct).replace(/^\/+/, '')}`;
  if (article.slug) return `https://${domain}/${String(article.slug).replace(/^\/+/, '')}`;
  if (article.id) return `https://${domain}/articles/${article.id}`;
  return '';
}

const upload = multer({ dest: uploadsDir });

async function extractText(filePath, mimetype) {
  try {
    if (mimetype === 'application/pdf') {
      const data = await pdfParse(fs.readFileSync(filePath));
      return data.text;
    } else if (mimetype.includes('word')) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) { return "Error extracting text"; }
}

const HELPJUICE_PROMPT = `You are an expert at converting structured knowledge base articles into clean, semantic HTML for the HelpJuice platform.

About FinBot: FinBot is an Israeli digital accounting software platform serving accounting firms and tax consultants. It provides double-entry and single-entry bookkeeping, automated reporting to authorities, AI-powered invoice scanning with 97% accuracy, and full human support.

## Component Identification
First, identify the semantic components present in the article:
- Summary/Opening — The introduction or overview paragraph
- Key Highlights — Important points, takeaways, or prerequisites
- Step-by-Step Instructions — Numbered procedures or workflows
- Explanatory Sections — Detailed descriptions, concepts, or context
- Callouts/Warnings — Important notes, tips, warnings, or cautions
- Related Links — References to other articles or resources
- FAQ — Frequently asked questions and answers

## Platform: HelpJuice
Generate HTML using these patterns:

Summary/Opening:
<div style="margin-bottom:40px;position:relative;">
<hr>
<div style="background-color:white;border-radius:10px;border-right:5px solid var(--accent, {{primaryColor}});box-shadow:0 2px 5px rgba(0,0,0,0.05);margin-bottom:25px;padding:20px;">
<p style="font-size:18px;line-height:1.6;margin:0;"><strong style="color:#3A3F41;">[Opening title]</strong></p>
<p style="font-size:18px;line-height:1.6;margin:0;">[Summary paragraph]</p>
</div></div>

Key Highlights:
<div style="text-align:center;width:100%;"><h2 id="-0" data-toc="true"><span style="color:hsl(196,4%,52%);"><strong>Important </strong>Highlights</span></h2><div style="background-color:var(--accent, {{primaryColor}});height:3px;margin:10px auto 20px;width:150px;">&nbsp;</div></div>
<div style="background-color:white;border-radius:10px;border-right:5px solid var(--accent, {{primaryColor}});box-shadow:0 2px 5px rgba(0,0,0,0.05);margin:20px 0;padding:20px;">
<ul style="list-style-type:none;">
<li style="border-bottom:1px solid #E4EBED;margin-bottom:12px;padding-bottom:15px;padding-left:25px;position:relative;"><span style="color:var(--accent, {{primaryColor}});font-size:20px;position:absolute;left:0;">&#10003;</span><span style="color:#3A3F41;font-size:18px;"><strong>[Highlight]</strong></span></li>
</ul></div>

Step-by-Step (HelpJuice Accordion):
<div style="text-align:center;width:100%;"><h2 id="-1" data-toc="true"><span style="color:hsl(196,4%,52%);"><strong>Execution Steps </strong>[Process Title]</span></h2><div style="background-color:var(--accent, {{primaryColor}});height:3px;margin:10px auto 20px;width:200px;">&nbsp;</div></div>
<div class="helpjuice-accordion" data-controller="editor--toggle-element">
<h2 class="helpjuice-accordion-title" id="1-2" data-toc="true">[Step Title]</h2>
<div class="helpjuice-accordion-body active" data-editor--toggle-element-target="body"><p style="font-size:18px;">[Step content]</p></div>
<div class="helpjuice-accordion-toggle">&nbsp;</div>
<div class="helpjuice-accordion-delete">&nbsp;</div>
</div>

Related Links:
<hr>
<div style="margin:30px 0;text-align:center;"><h2 id="-9" data-toc="true"><span style="color:hsl(196,4%,52%);"><strong>Links</strong> to Additional Processes</span></h2><div style="background-color:var(--accent, {{primaryColor}});height:3px;margin:10px auto 20px;width:200px;">&nbsp;</div></div>
<div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:center;margin:30px 0;">
<div style="background-color:white;border-radius:10px;box-shadow:0 3px 10px rgba(0,0,0,0.1);flex:1;min-width:250px;overflow:hidden;">
<div style="background-color:#E4EBED;padding:15px;text-align:center;"><h3 style="color:#3A3F41;margin:0;">[Link Title]</h3></div>
<div style="padding:15px;"><p>[Short description]</p><div style="text-align:center;"><a style="background-color:var(--accent, {{primaryColor}});border-radius:5px;color:white;display:inline-block;padding:8px 15px;text-decoration:none;" href="#">Learn More</a></div></div>
</div></div>

FAQ:
<hr>
<div style="margin:30px 0;text-align:center;"><h2 id="-4" data-toc="true"><span style="color:hsl(196,4%,52%);"><strong>Frequently</strong> Asked Questions</span></h2><div style="background-color:var(--accent, {{primaryColor}});height:3px;margin:10px auto 20px;width:200px;">&nbsp;</div></div>
<div class="helpjuice-accordion" data-controller="editor--toggle-element">
<h2 class="helpjuice-accordion-title" id="1-5" data-toc="true">[Question]</h2>
<div class="helpjuice-accordion-body active" data-editor--toggle-element-target="body"><p style="font-size:18px;">[Answer]</p></div>
<div class="helpjuice-accordion-toggle">&nbsp;</div>
<div class="helpjuice-accordion-delete">&nbsp;</div>
</div>

## Rules
- Output ONLY the HTML code — no explanations, no markdown backticks
- Use inline styles throughout
- Be creative inside accordion bodies: use cards, grids, colored boxes
- If source is in Hebrew, translate content to the same language as the source
- Maintain sequential IDs on headings`;

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  const text = await extractText(req.file.path, req.file.mimetype);
  fs.writeFileSync(path.join(textsDir, req.file.filename + '.txt'), text);
  res.json({ success: true, filename: req.file.originalname, text: text.substring(0, 500) });
});

app.get('/knowledge', (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const requestedMaxChars = Number(req.query.maxChars) || DEFAULT_KNOWLEDGE_MAX_CHARS;
    const knowledge = selectRelevantKnowledge(query, requestedMaxChars);
    res.json({ knowledge });
  } catch (e) {
    res.status(500).json({ knowledge: '', error: e.message });
  }
});

app.get('/api/keys/status', (req, res) => {
  try {
    const status = {};
    allowedKeyIds.forEach((id) => {
      status[id] = !!(keyStore[id] && keyStore[id].trim());
    });
    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/keys', (req, res) => {
  try {
    const { id, value } = req.body || {};
    if (!allowedKeyIds.includes(id)) {
      return res.status(400).json({ success: false, error: 'Invalid key id' });
    }
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ success: false, error: 'Missing key value' });
    }
    keyStore[id] = value.trim();
    persistKeys();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/keys/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (!allowedKeyIds.includes(id)) {
      return res.status(400).json({ success: false, error: 'Invalid key id' });
    }
    keyStore[id] = '';
    persistKeys();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function normalizeHelpjuiceDomain(rawDomain) {
  if (!rawDomain || typeof rawDomain !== 'string') return '';
  const cleaned = rawDomain.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return cleaned.split('/')[0];
}

function parseSelectedCategoryIds(raw) {
  if (!Array.isArray(raw)) return [];
  const unique = new Set();
  raw.forEach((value) => {
    const normalized = String(value || '').trim();
    if (normalized) unique.add(normalized);
  });
  return Array.from(unique);
}

function clearKnowledgeDirectories() {
  [uploadsDir, textsDir].forEach((dir) => {
    const files = fs.readdirSync(dir);
    files.forEach((fileName) => {
      const filePath = path.join(dir, fileName);
      if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
    });
  });
}

function collectArticleCategoryIds(article) {
  const ids = [];
  const pushValue = (v) => {
    if (v === null || v === undefined || v === '') return;
    ids.push(String(v));
  };

  pushValue(article.category_id);
  pushValue(article.categoryId);
  pushValue(article.folder_id);
  pushValue(article.folderId);

  if (Array.isArray(article.category_ids)) article.category_ids.forEach(pushValue);
  if (Array.isArray(article.categoryIds)) article.categoryIds.forEach(pushValue);
  if (Array.isArray(article.folder_ids)) article.folder_ids.forEach(pushValue);

  return Array.from(new Set(ids));
}

function normalizeCategoryId(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value).trim();
}

function normalizeCategoryParentId(category) {
  return normalizeCategoryId(
    category.parent_id ??
    category.parentId ??
    category.parent_category_id ??
    category.parentCategoryId ??
    category.parent ??
    ''
  );
}

function expandSelectedCategoryIds(selectedIds, categories) {
  const byParent = new Map();
  categories.forEach((category) => {
    const parentId = normalizeCategoryParentId(category);
    const id = normalizeCategoryId(category.id ?? category.category_id);
    if (!id) return;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(id);
  });

  const expanded = new Set(selectedIds);
  const queue = [...selectedIds];
  while (queue.length) {
    const current = queue.shift();
    const children = byParent.get(current) || [];
    children.forEach((childId) => {
      if (!expanded.has(childId)) {
        expanded.add(childId);
        queue.push(childId);
      }
    });
  }

  return Array.from(expanded);
}

function helpjuiceHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey
  };
}

function helpjuiceHeaderVariants(apiKey) {
  return [
    { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    { 'Content-Type': 'application/json', 'x-auth-token': apiKey },
    { 'Content-Type': 'application/json', 'X-Auth-Token': apiKey },
    { 'Content-Type': 'application/json', 'api-key': apiKey },
    { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
    { 'Content-Type': 'application/json', Authorization: `Token token=${apiKey}` }
  ];
}

async function fetchHelpjuiceWithFallback(url, options, apiKey) {
  const attempts = [];
  const urlVariants = [
    url,
    url.includes('?') ? `${url}&api_key=${encodeURIComponent(apiKey)}` : `${url}?api_key=${encodeURIComponent(apiKey)}`,
    url.includes('?') ? `${url}&token=${encodeURIComponent(apiKey)}` : `${url}?token=${encodeURIComponent(apiKey)}`,
    url.includes('?') ? `${url}&access_token=${encodeURIComponent(apiKey)}` : `${url}?access_token=${encodeURIComponent(apiKey)}`
  ];

  for (const candidateUrl of urlVariants) {
    for (const headers of helpjuiceHeaderVariants(apiKey)) {
      const response = await fetch(candidateUrl, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      if (response.ok) return { ok: true, response, attempts };
      const body = await response.text();
      attempts.push({
        url: candidateUrl,
        status: response.status,
        body: (body || '').substring(0, 400)
      });
    }
  }
  return { ok: false, attempts };
}

app.post('/helpjuice/categories', async (req, res) => {
  try {
    const apiKey = keyStore.hj || process.env.HELPJUICE_API_KEY || '';
    const rawDomain = (req.body && req.body.domain) || process.env.HELPJUICE_DOMAIN || '';
    const domain = normalizeHelpjuiceDomain(rawDomain);

    if (!apiKey) return res.status(400).json({ success: false, error: 'HelpJuice API key is not configured' });
    if (!domain) return res.status(400).json({ success: false, error: 'HelpJuice domain is missing' });

    const base = `https://${domain}/api/v3`;
    const categoriesTry = await fetchHelpjuiceWithFallback(`${base}/categories?limit=200`, { method: 'GET' }, apiKey);
    if (!categoriesTry.ok) {
      return res.status(502).json({
        success: false,
        error: 'Failed to load HelpJuice categories',
        details: categoriesTry.attempts
      });
    }

    const categoriesJson = await categoriesTry.response.json();
    const categories = extractCollection(categoriesJson, 'categories');
    const normalized = categories.map((c) => {
      const id = normalizeCategoryId(c.id ?? c.category_id ?? '');
      const parentId = normalizeCategoryParentId(c);
      return {
        id,
        parentId,
        name: String(c.name || c.title || c.slug || `קטגוריה ${id || ''}`).trim()
      };
    }).filter((c) => c.id);

    res.json({ success: true, domain, categories: normalized });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/helpjuice/sync', async (req, res) => {
  try {
    const apiKey = keyStore.hj || process.env.HELPJUICE_API_KEY || '';
    const rawDomain = (req.body && req.body.domain) || process.env.HELPJUICE_DOMAIN || '';
    const domain = normalizeHelpjuiceDomain(rawDomain);
    const selectedCategoryIds = parseSelectedCategoryIds(req.body && req.body.categoryIds);
    const clearExisting = (req.body && req.body.clearExisting) !== false;

    if (!apiKey) return res.status(400).json({ success: false, error: 'HelpJuice API key is not configured' });
    if (!domain) return res.status(400).json({ success: false, error: 'HelpJuice domain is missing' });
    if (!selectedCategoryIds.length) {
      return res.status(400).json({ success: false, error: 'No HelpJuice folders were selected' });
    }

    const base = `https://${domain}/api/v3`;
    const [articlesTry, categoriesTry] = await Promise.all([
      fetchHelpjuiceWithFallback(`${base}/articles?limit=200`, { method: 'GET' }, apiKey),
      fetchHelpjuiceWithFallback(`${base}/categories?limit=200`, { method: 'GET' }, apiKey)
    ]);

    if (!articlesTry.ok || !categoriesTry.ok) {
      const articleErr = articlesTry.attempts || [];
      const categoryErr = categoriesTry.attempts || [];
      const firstArticleErr = articleErr[0] || null;
      const firstCategoryErr = categoryErr[0] || null;
      return res.status(502).json({
        success: false,
        error: 'Failed to connect to HelpJuice API',
        hint: 'בדקי שהדומיין הוא מהפורמט yourcompany.helpjuice.com ושה-API key תקין',
        details: {
          summary: 'HelpJuice rejected all supported auth formats',
          firstArticleErr,
          firstCategoryErr,
          articleErr,
          categoryErr
        }
      });
    }

    const articlesJson = await articlesTry.response.json();
    const categoriesJson = await categoriesTry.response.json();
    const allArticles = extractCollection(articlesJson, 'articles');
    const categories = extractCollection(categoriesJson, 'categories');
    const selectedCategorySet = new Set(selectedCategoryIds.map((id) => normalizeCategoryId(id)));
    const selectedCategories = categories.filter((c) => selectedCategorySet.has(normalizeCategoryId(c.id)));
    const expandedCategoryIds = expandSelectedCategoryIds(selectedCategoryIds, categories);
    const allowedCategoryIds = new Set(expandedCategoryIds.map((id) => normalizeCategoryId(id)));
    const articles = allArticles.filter((a) => {
      const articleIds = collectArticleCategoryIds(a);
      return articleIds.some((id) => allowedCategoryIds.has(id));
    });

    const articleCount = articles.length;
    const categoryCount = categories.length || categoriesJson.total || categoriesJson.count || 0;

    // Remove previous local knowledge so agents only use the latest selected folders.
    if (clearExisting) {
      clearKnowledgeDirectories();
    }

    // Build local knowledge from synced HelpJuice routes + content.
    let learnedArticles = 0;
    let withLinks = 0;

    for (let i = 0; i < articles.length; i++) {
      const a = articles[i] || {};
      const title = (a.title || a.name || `HelpJuice Article ${i + 1}`).trim();
      const key = safeTitleForFile(String(a.id || a.slug || title || i));
      const baseName = `hj-sync-${key}`;
      const htmlFileName = `${baseName}.html`;
      const htmlContent = String(a.body || a.content || a.html || '');
      const plainContent = htmlToPlainText(htmlContent || a.summary || a.excerpt || a.description || '');
      const articleUrl = resolveHelpjuiceArticleUrl(domain, a);
      if (articleUrl) withLinks += 1;

      const knowledgeText = [
        'מקור: HelpJuice',
        `כותרת: ${title}`,
        `קישור: ${articleUrl || 'לא זמין'}`,
        `מזהה: ${a.id || ''}`,
        '',
        plainContent
      ].join('\n').trim();

      fs.writeFileSync(path.join(uploadsDir, htmlFileName), htmlContent || `<h1>${title}</h1>`, 'utf8');
      fs.writeFileSync(path.join(textsDir, `${htmlFileName}.txt`), knowledgeText, 'utf8');
      learnedArticles += 1;
    }

    res.json({
      success: true,
      domain,
      selectedCategoryIds,
      expandedCategoryIds,
      selectedCategoryCount: selectedCategories.length,
      effectiveCategoryCount: expandedCategoryIds.length,
      articleCount,
      categoryCount,
      learnedArticles,
      withLinks,
      syncedAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/helpjuice/publish', async (req, res) => {
  try {
    const apiKey = keyStore.hj || process.env.HELPJUICE_API_KEY || '';
    const rawDomain = (req.body && req.body.domain) || process.env.HELPJUICE_DOMAIN || '';
    const domain = normalizeHelpjuiceDomain(rawDomain);
    const { title, html } = req.body || {};

    if (!apiKey) return res.status(400).json({ success: false, error: 'HelpJuice API key is not configured' });
    if (!domain) return res.status(400).json({ success: false, error: 'HelpJuice domain is missing' });
    if (!html || typeof html !== 'string') return res.status(400).json({ success: false, error: 'Missing HTML to publish' });

    const base = `https://${domain}/api/v3`;
    const pending = true;
    const publishTry = await fetchHelpjuiceWithFallback(`${base}/articles`, {
      method: 'POST',
      body: JSON.stringify({
        title: (title || 'מאמר חדש מ-FinBot').trim(),
        body: html,
        content: html,
        status: pending ? 'draft' : 'published',
        published: !pending
      })
    }, apiKey);

    if (!publishTry.ok) {
      return res.status(502).json({
        success: false,
        error: 'HelpJuice publish failed',
        hint: 'בדקי דומיין, הרשאות API, ופורמט גוף הבקשה במערכת HelpJuice',
        details: publishTry.attempts
      });
    }

    const raw = await publishTry.response.text();
    let payload;
    try { payload = JSON.parse(raw); }
    catch { payload = { raw }; }

    // Save article locally for knowledge retrieval by agents.
    const stamp = Date.now();
    const fileBase = `hj-${stamp}-${safeTitleForFile(title)}`;
    const htmlName = `${fileBase}.html`;
    fs.writeFileSync(path.join(uploadsDir, htmlName), html, 'utf8');
    fs.writeFileSync(path.join(textsDir, `${htmlName}.txt`), htmlToPlainText(html), 'utf8');

    res.json({ success: true, result: payload, pendingApproval: pending, learned: true, savedFile: htmlName });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/chat', async (req, res) => {
  const { system, messages } = req.body || {};
  try {
    const anthropicKey = keyStore.ant || process.env.ANTHROPIC_API_KEY || '';
    if (!anthropicKey) throw new Error('Anthropic API key is not configured');
    const sanitizedMessages = Array.isArray(messages)
      ? messages
        .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
        .map((message) => ({ role: message.role, content: String(message.content || '').trim() }))
        .filter((message) => message.content)
        .slice(-CHAT_HISTORY_LIMIT)
      : [];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1800,
        temperature: 0,
        system: typeof system === 'string' && system.trim() ? system : 'אתה עוזר פיננסי',
        messages: sanitizedMessages.length > 0 ? sanitizedMessages : [{ role: 'user', content: 'שלום' }]
      })
    });
    clearTimeout(timeoutId);
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!response.ok) throw new Error(data.error?.message || raw || 'API Error');
    const reply = Array.isArray(data.content)
      ? data.content
        .filter((block) => block && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n')
        .trim()
      : '';
    if (!reply) throw new Error('Empty AI response');
    res.json({ reply });
  } catch(e) {
    console.error(e);
    const status = e.name === 'AbortError' ? 504 : 500;
    const message = e.name === 'AbortError' ? 'Chat request timed out' : e.message;
    res.status(status).json({ error: message });
  }
});

// נתיב חדש — יצירת מאמר HelpJuice
app.post('/generate-article', async (req, res) => {
  const { text, filename } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    const anthropicKey = keyStore.ant || process.env.ANTHROPIC_API_KEY || '';
    if (!anthropicKey) throw new Error('Anthropic API key is not configured');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 4096,
        system: HELPJUICE_PROMPT,
        messages: [{ role: 'user', content: `Convert this document into a HelpJuice article:\n\n${text}` }]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'API Error');
    const html = data.content[0].text;
    res.json({ success: true, html, filename });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/files', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir).map(f => {
      const textFile = path.join(textsDir, f + '.txt');
      const text = fs.existsSync(textFile) ? fs.readFileSync(textFile, 'utf8') : '';
      const source = f.startsWith('hj-') ? 'hj' : 'manual';
      return {
        name: source === 'hj' ? f.replace(/^hj-\d+-/, '').replace(/\.html?$/i, '') : f.replace(/^\w+-/, ''),
        filename: f,
        date: fs.statSync(path.join(uploadsDir, f)).mtime,
        source,
        text: text.substring(0, 1000)
      };
    });
    res.json({ files });
  } catch (e) {
    res.json({ files: [] });
  }
});

app.delete('/files/:filename', (req, res) => {
  const filename = req.params.filename;
  try {
    const fp = path.join(uploadsDir, filename);
    const tp = path.join(textsDir, filename + '.txt');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(APP_DIR, 'finbot-hub.html'));
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}. Data dir: ${DATA_DIR}`));