/**
 * server.ts — Local validation dashboard server
 * 
 * Serves HTML pages and provides APIs to:
 *   - Get/update test-urls.json config
 *   - Trigger Playwright tests with live log streaming
 *   - List PDF files
 * 
 * Run: npx tsx scripts/server.ts
 * Open: http://localhost:3000
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config/test-urls.json');
const PAGES_DIR = path.join(ROOT, 'pages');
const PDF_DIR = path.join(ROOT, 'PDF');
const REPORTS_DIR = path.join(ROOT, 'reports');
const UI_REPORTS_DIR = path.join(ROOT, '.ui_reports');
const CSV_DIR = path.join(ROOT, '.temp_csv');

if (!fs.existsSync(UI_REPORTS_DIR)) fs.mkdirSync(UI_REPORTS_DIR, { recursive: true });
if (!fs.existsSync(CSV_DIR)) fs.mkdirSync(CSV_DIR, { recursive: true });

if (!fs.existsSync(UI_REPORTS_DIR)) fs.mkdirSync(UI_REPORTS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(PAGES_DIR));

// Multer for PDF uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req: any, _file: any, cb: any) => {
      const env = req.body?.env || 'prod';
      const dir = path.join(PDF_DIR, env);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req: any, file: any, cb: any) => {
      cb(null, file.originalname);
    },
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

// Multer for CSV uploads
const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (_req: any, _file: any, cb: any) => {
      cb(null, CSV_DIR);
    },
    filename: (_req: any, file: any, cb: any) => {
      cb(null, `master-${Date.now()}.csv`);
    },
  }),
});

// ─── State ───────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  process: ChildProcess | null;
  logs: string[];
  status: 'running' | 'done' | 'error';
  summary: string;
  reportFile?: string;
  results?: {
    overall: number;
    headings: number;
    tables: number;
    images: number;
    content: number;
  };
}

const jobs = new Map<string, Job>();
let currentJob: Job | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns URLs as-is (previously added ?wcmmode=disabled) */
function normalizeUrls(stage: string, production: string) {
  // User requested to stop adding ?wcmmode=disabled
  return { stage, production };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Redirect root to content-validation page
app.get('/', (_req, res) => {
  res.redirect('/content-validation.html');
});

// AEM session status
const SESSION_METADATA_PATH = path.join(ROOT, 'auth-sessions/session-metadata.json');

app.get('/api/aem-status', (_req, res) => {
  try {
    if (!fs.existsSync(SESSION_METADATA_PATH)) {
      res.json({ connected: false, reason: 'No session found' });
      return;
    }
    const meta = JSON.parse(fs.readFileSync(SESSION_METADATA_PATH, 'utf-8'));
    const now = new Date();
    const expiresAt = meta.expiresAt ? new Date(meta.expiresAt) : null;
    if (!expiresAt || expiresAt < now) {
      res.json({ connected: false, reason: 'Session expired', username: meta.username || null });
      return;
    }
    res.json({
      connected: true,
      username: meta.username || 'Unknown',
      expiresAt: meta.expiresAt,
      cookieCount: meta.cookieCount || 0,
    });
  } catch {
    res.json({ connected: false, reason: 'Failed to read session' });
  }
});

// Get current config
app.get('/api/config', (_req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    res.json(config);
  } catch {
    res.json({ stage: '', production: '' });
  }
});

// List PDF files
app.get('/api/pdf-files', (_req, res) => {
  const getFiles = (dir: string) => {
    try {
      return fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return { name: f, size: formatSize(stat.size) };
        });
    } catch { return []; }
  };

  res.json({
    prod: getFiles(path.join(PDF_DIR, 'prod')),
    stage: getFiles(path.join(PDF_DIR, 'stage')),
  });
});

// Upload PDF
app.post('/api/upload-pdf', upload.single('pdf'), (req: any, res: any) => {
  if (!req.file) {
    res.json({ error: 'No file uploaded' });
    return;
  }
  res.json({ ok: true, filename: req.file.originalname, env: req.body.env });
});

// Upload CSV
app.post('/api/upload-csv', csvUpload.single('csv'), (req: any, res: any) => {
  if (!req.file) {
    res.json({ error: 'No file uploaded' });
    return;
  }
  res.json({ ok: true, path: req.file.path, filename: req.file.originalname });
});

// Run content-parity validation
app.post('/api/run/content-parity', (req: any, res: any) => {
  const { stage, production } = req.body;
  if (!stage && !production) {
    res.json({ error: 'At least one URL is required' });
    return;
  }

  // Update test-urls.json with normalized URLs (for record keeping)
  const normalized = normalizeUrls(stage, production);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));

  const reportFile = `content-parity-${Date.now()}.xlsx`;
  const reportPath = path.join(UI_REPORTS_DIR, reportFile);

  const job = startTest('content-parity', [
    'python3', '-u', 'scripts/content_parity.py'
  ], {
    STAGE_URL: normalized.stage,
    PROD_URL: normalized.production,
    REPORT_FILENAME: reportPath
  });
  job.reportFile = reportFile;

  res.json({ jobId: job.id });
});

// Run deep-content-validation
app.post('/api/run/deep-content-validation', (req: any, res: any) => {
  const { stage, production } = req.body;
  if (!stage && !production) {
    res.json({ error: 'At least one URL is required' });
    return;
  }

  const normalized = normalizeUrls(stage || '', production || '');
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));

  const reportFile = `deep-content-validation-${Date.now()}.xlsx`;
  const reportPath = path.join(UI_REPORTS_DIR, reportFile);

  const job = startTest('deep-content-validation', [
    'python3', '-u', 'scripts/deep_content_validation.py'
  ], {
    STAGE_URL: normalized.stage,
    PROD_URL: normalized.production,
    REPORT_FILENAME: reportPath
  });
  job.reportFile = reportFile;

  res.json({ jobId: job.id });
});

// Run leftnav-validation
app.post('/api/run/leftnav-validation', (req: any, res: any) => {
  const { stage, production } = req.body;
  if (!stage && !production) {
    res.json({ error: 'At least one URL is required' });
    return;
  }

  // Update test-urls.json with normalized URLs (for record keeping)
  const normalized = normalizeUrls(stage || '', production || '');
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));

  const reportFile = `leftnav-toc-${Date.now()}.xlsx`;
  const reportPath = path.join(UI_REPORTS_DIR, reportFile);

  const job = startTest('leftnav-validation', [
    'npx', 'playwright', 'test',
    'tests/content-validation/leftnav-toc-validation.spec.ts',
    '--reporter=list'
  ], {
    STAGE_URL: normalized.stage,
    PROD_URL: normalized.production,
    REPORT_FILENAME: reportPath
  });
  job.reportFile = reportFile;

  res.json({ jobId: job.id });
});

// Run pdf-validation
app.post('/api/run/pdf-validation', (req: any, res: any) => {
  const { stage, production, stageFile, prodFile } = req.body;
  
  // Update test-urls.json for record keeping (if urls provided)
  if (stage || production) {
    const normalized = normalizeUrls(stage || '', production || '');
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));
  }

  const reportFile = `pdf-validation-${Date.now()}.xlsx`;
  const reportPath = path.join(UI_REPORTS_DIR, reportFile);

  const job = startTest('pdf-validation', [
    'npx', 'playwright', 'test',
    'tests/content-validation/pdf-validation.spec.ts',
    '--reporter=list'
  ], {
    REPORT_FILENAME: reportPath,
    STAGE_FILE: stageFile || '',
    PROD_FILE: prodFile || ''
  });
  job.reportFile = reportFile;

  res.json({ jobId: job.id });
});

// Run metadata-validation
app.post('/api/run/metadata-validation', (req: any, res: any) => {
  const { stageUrl, csvPath } = req.body;
  if (!stageUrl || !csvPath) {
    res.json({ error: 'Stage URL and CSV file are required' });
    return;
  }

  const reportFile = `metadata-validation-${Date.now()}.xlsx`;
  const reportPath = path.join(UI_REPORTS_DIR, reportFile);

  const job = startTest('metadata-validation', [
    'python3', '-u', 'scripts/metadata_validation.py'
  ], {
    STAGE_URL: stageUrl,
    MASTER_CSV: csvPath,
    REPORT_FILENAME: reportPath
  });
  job.reportFile = reportFile;

  res.json({ jobId: job.id });
});

// Run broken-links crawler (Python Version)
app.post('/api/run/broken-links', (req: any, res: any) => {
  const { url } = req.body;
  if (!url) {
    res.json({ error: 'URL is required' });
    return;
  }

  const reportFile = `broken-links-${Date.now()}.xlsx`;
  const reportPath = path.join(UI_REPORTS_DIR, reportFile);

  const job = startTest('broken-links', [
    'python3', '-u', 'scripts/broken_links.py'
  ], {
    PROD_URL: url,
    REPORT_FILENAME: reportPath
  });
  job.reportFile = reportFile;

  res.json({ jobId: job.id });
});

// Run AEM Login
app.post('/api/login', (req: any, res: any) => {
  const { url, username, password } = req.body;
  if (!url || !username || !password) {
    res.json({ error: 'URL, username, and password are required' });
    return;
  }

  const job = startTest('aem-login', [
    'npx', 'tsx', 'run_login.ts'
  ], {
    BASE_URL: url,
    AEM_USERNAME: username,
    AEM_PASSWORD: password
  });

  res.json({ jobId: job.id });
});

// Disconnect/Logout AEM
app.post('/api/logout', (_req, res) => {
  try {
    const sessionDir = path.join(ROOT, 'auth-sessions');
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir);
      for (const file of files) {
        fs.unlinkSync(path.join(sessionDir, file));
      }
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to disconnect: ' + err.message });
  }
});

// Stream logs via SSE
app.get('/api/logs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send existing logs
  for (const line of job.logs) {
    res.write(`data: ${JSON.stringify({ type: 'log', data: line })}\n\n`);
  }

  if (job.status === 'done') {
    res.write(`data: ${JSON.stringify({ type: 'done', summary: job.summary, reportFile: job.reportFile, results: job.results })}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', data: job.summary })}\n\n`);
    res.end();
    return;
  }

  // Stream new logs
  const interval = setInterval(() => {
    // Check for new logs since last send
  }, 500);

  let lastIdx = job.logs.length;
  const poller = setInterval(() => {
    while (lastIdx < job.logs.length) {
      res.write(`data: ${JSON.stringify({ type: 'log', data: job.logs[lastIdx] })}\n\n`);
      lastIdx++;
    }
    if (job.status === 'done') {
      res.write(`data: ${JSON.stringify({ type: 'done', summary: job.summary, reportFile: job.reportFile, results: job.results })}\n\n`);
      clearInterval(poller);
      clearInterval(interval);
      res.end();
    } else if (job.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'error', data: job.summary })}\n\n`);
      clearInterval(poller);
      clearInterval(interval);
      res.end();
    }
  }, 300);

  req.on('close', () => {
    clearInterval(poller);
    clearInterval(interval);
  });
});

// Stop test(s)
app.post('/api/stop', (req, res) => {
  const { jobId } = req.body;
  
  if (jobId) {
    const job = jobs.get(jobId);
    if (job?.process) {
      job.process.kill('SIGTERM');
      job.status = 'error';
      job.summary = 'Stopped by user';
    }
  } else {
    // If no ID provided, stop all running jobs
    for (const job of jobs.values()) {
      if (job.process) {
        job.process.kill('SIGTERM');
        job.status = 'error';
        job.summary = 'Stopped by user';
      }
    }
  }
  res.json({ ok: true });
});

// Serve reports for download (static)
app.use('/reports', express.static(REPORTS_DIR));

// Explicit download endpoint — forces browser Save As dialog
app.get('/api/download/:filename', (req: any, res: any) => {
  const { filename } = req.params;
  const filePath = path.resolve(UI_REPORTS_DIR, filename);
  const fallbackPath = path.resolve(REPORTS_DIR, filename);
  
  console.log(`🔍 Download Request: ${filename}`);
  console.log(`   Trying: ${filePath}`);
  
  const finalPath = fs.existsSync(filePath) ? filePath : (fs.existsSync(fallbackPath) ? fallbackPath : null);

  if (finalPath) {
    console.log(`   ✅ Found: ${finalPath}`);
    try {
      const fileBuffer = fs.readFileSync(finalPath);
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pdf':  'application/pdf',
        '.csv':  'text/csv',
        '.txt':  'text/plain',
        '.json': 'application/json',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileBuffer.length);
      res.end(fileBuffer);
    } catch (err: any) {
      console.error(`   ❌ Read error for ${filename}:`, err);
      res.status(500).json({ error: 'Failed to read file' });
    }
  } else {
    console.warn(`   ⚠️ Not found in .ui_reports or reports/`);
    res.status(404).json({ error: 'File not found' });
  }
});

// List available reports
app.get('/api/reports', (_req, res) => {
  try {
    const files = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.xlsx') || f.endsWith('.pdf'))
      .filter(f => !f.startsWith('~$')) // skip temp files
      .map(f => {
        const stat = fs.statSync(path.join(REPORTS_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    res.json(files);
  } catch {
    res.json([]);
  }
});

// Get report data as JSON for UI rendering
app.get('/api/report-data/:type', async (req, res) => {
  const { type } = req.params;
  const jobId = req.query.jobId as string;
  
  const typeMap: Record<string, string> = {
    'content-parity': 'content-parity-report.xlsx',
    'deep-content-validation': 'deep-content-validation-report.xlsx',
    'leftnav':        'leftnav-toc-validation-report.xlsx',
    'pdf-validation': 'pdf-validation-report.xlsx',
    'metadata-validation': 'metadata-validation-report.xlsx',
    'broken-links':   'broken-links-report.xlsx',
  };

  let xlsxPath = '';
  
  // 1. If jobId provided, look in UI_REPORTS_DIR via jobs map
  if (jobId && jobs.has(jobId)) {
    const job = jobs.get(jobId)!;
    if (job.reportFile) {
      xlsxPath = path.join(UI_REPORTS_DIR, job.reportFile);
    }
  }

  // 2. If no path yet, look for latest timestamped file in UI_REPORTS_DIR for this type
  if (!xlsxPath || !fs.existsSync(xlsxPath)) {
    try {
      const files = fs.readdirSync(UI_REPORTS_DIR)
        .filter(f => f.startsWith(type) && f.endsWith('.xlsx'))
        .map(f => ({ name: f, time: fs.statSync(path.join(UI_REPORTS_DIR, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);
      
      if (files.length > 0) {
        xlsxPath = path.join(UI_REPORTS_DIR, files[0].name);
      }
    } catch (e) {}
  }

  // 3. Fallback to static name in REPORTS_DIR
  if (!xlsxPath || !fs.existsSync(xlsxPath)) {
    const staticName = typeMap[type];
    if (staticName) {
      xlsxPath = path.join(REPORTS_DIR, staticName);
    }
  }

  if (!xlsxPath || !fs.existsSync(xlsxPath)) {
    res.status(404).json({ error: `Excel report for "${type}" not found. Run validation first.` });
    return;
  }

  try {
    const ExcelJSModule = await import('exceljs');
    const ExcelJS = ExcelJSModule.default || ExcelJSModule;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);

    const sheetsData: any[] = [];
    wb.worksheets.forEach(ws => {
      const rows: any[] = [];
      ws.eachRow({ includeEmpty: true }, (row) => {
        const rowData: any[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          rowData.push(cell.value);
        });
        rows.push(rowData);
      });
      sheetsData.push({ name: ws.name, rows });
    });

    res.json({ sheets: sheetsData });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read report data: ' + err.message });
  }
});

// Generate PDF report from xlsx data
app.get('/api/generate-pdf/:type', async (req, res) => {
  const typeMap: Record<string, string> = {
    'content-parity': 'content-parity-report.xlsx',
    'leftnav':        'leftnav-toc-validation-report.xlsx',
    'pdf-validation': 'pdf-validation-report.xlsx',
    'metadata-validation': 'metadata-validation-report.xlsx',
  };
  const xlsxName = typeMap[req.params.type];
  if (!xlsxName) { res.status(400).json({ error: 'Unknown report type' }); return; }

  const xlsxPath = path.join(REPORTS_DIR, xlsxName);
  if (!fs.existsSync(xlsxPath)) {
    res.status(404).json({ error: `Excel report not found. Run validation first.` });
    return;
  }

  try {
    const ExcelJSModule = await import('exceljs');
    const ExcelJS = ExcelJSModule.default || ExcelJSModule;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);

    const pdfFilename = xlsxName.replace('.xlsx', '.pdf');
    const pdfPath = path.join(REPORTS_DIR, pdfFilename);

    // Build a simple PDF by extracting all sheets as text tables
    // Using a lightweight approach — generate HTML then convert to pdf buffer
    let htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 9px; margin: 20px; color: #222; }
  h1 { color: #1F4E78; font-size: 16px; border-bottom: 2px solid #1F4E78; padding-bottom: 6px; }
  h2 { color: #1F4E78; font-size: 12px; margin-top: 20px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 20px; font-size: 8px; }
  th { background: #1F4E78; color: white; padding: 5px 8px; text-align: left; border: 1px solid #aaa; }
  td { padding: 4px 8px; border: 1px solid #ccc; vertical-align: top; max-width: 300px; word-break: break-word; }
  tr:nth-child(even) { background: #f0f4f8; }
  .meta { color: #666; font-size: 10px; margin-bottom: 16px; }
  @media print { h2 { page-break-before: auto; } }
</style>
</head>
<body>
<h1>📊 ${req.params.type.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase())} Report</h1>
<p class="meta">Generated: ${new Date().toLocaleString()}</p>
`;

    wb.worksheets.forEach(ws => {
      htmlContent += `<h2>${ws.name}</h2><table>`;
      ws.eachRow((row, rIdx) => {
        htmlContent += '<tr>';
        row.eachCell({ includeEmpty: true }, (cell) => {
          const val = String(cell.value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          
          // Extract background color if present
          let style = '';
          if (cell.fill && cell.fill.type === 'pattern' && cell.fill.fgColor && (cell.fill.fgColor as any).argb) {
            const argb = (cell.fill.fgColor as any).argb;
            // Excel ARGB to CSS (AARRGGBB -> #RRGGBB)
            const hex = '#' + argb.substring(2);
            style = `style="background-color: ${hex}; ${argb === 'FFFF0000' ? 'color: white;' : ''}"`;
          }

          if (rIdx === 1) {
            htmlContent += `<th ${style}>${val}</th>`;
          } else {
            htmlContent += `<td ${style}>${val}</td>`;
          }
        });
        htmlContent += '</tr>';
      });
      htmlContent += '</table>';
    });

    htmlContent += '</body></html>';

    // Write as HTML file with .pdf extension note — but actually save as proper PDF
    // Since we have puppeteer available via playwright, use that
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A3',
      landscape: true,
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '10mm', right: '10mm' },
    });
    await browser.close();

    // DONT save to disk if it's a UI request (we stream it)
    // res.send(pdfBuffer) already sends the buffer.

    res.setHeader('Content-Disposition', `attachment; filename="${pdfFilename}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (err: any) {
    console.error('PDF generation error:', err.message);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startTest(name: string, cmd: string[], extraEnv: Record<string, string> = {}): Job {
  const id = `${name}-${Date.now()}`;
  const job: Job = { id, process: null, logs: [], status: 'running', summary: '' };
  jobs.set(id, job);
  currentJob = job;

  job.logs.push(`🚀 Starting ${name} validation...`);
  job.logs.push(`   Command: ${cmd.join(' ')}`);
  job.logs.push('');

  const proc = spawn(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, ...extraEnv, FORCE_COLOR: '0' },
  });

  job.process = proc;

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        if (trimmed.startsWith('::RESULTS::')) {
          try {
            const resultData = JSON.parse(trimmed.replace('::RESULTS::', ''));
            job.results = resultData;
          } catch (e) {
            console.error('Failed to parse results JSON:', e);
          }
        } else {
          job.logs.push(line);
        }
      }
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) job.logs.push(line);
    }
  });

  proc.on('close', (code) => {
    if (code === 0) {
      job.status = 'done';
      job.summary = `Test passed. Report saved to reports/`;
      job.logs.push('');
      job.logs.push('✅ Test completed successfully!');
    } else {
      job.status = job.status === 'error' ? 'error' : 'error';
      job.summary = job.summary || `Test exited with code ${code}`;
      job.logs.push('');
      job.logs.push(`❌ Test exited with code ${code}`);
    }
    job.process = null;
  });

  proc.on('error', (err) => {
    job.status = 'error';
    job.summary = err.message;
    job.logs.push(`❌ Error: ${err.message}`);
    job.process = null;
  });

  return job;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ─── Start ───────────────────────────────────────────────────────────────────

// Global Error Handler
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('💥 Server Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// 404 handler for API
app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        🔍 Validation Dashboard Server                   ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${PORT}                            ║`);
  console.log('║                                                          ║');
  console.log('║  Pages:                                                  ║');
  console.log('║    • TOC Parity          → /content-parity.html          ║');
  console.log('║    • TOC Validation      → /content-validation.html      ║');
  console.log('║    • Left Nav Validation → /leftnav-validation.html      ║');
  console.log('║    • PDF Validation      → /pdf-validation.html          ║');
  console.log('║    • Metadata Validation → /metadata-validation.html     ║');
  console.log('║                                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
