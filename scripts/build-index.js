#!/usr/bin/env node
// scripts/build-index.js — CLI index builder.  npm run index [-- --force]

import { buildAllIndexes } from '../lib/index-store.js';
import { log } from '../lib/logger.js';

const force = process.argv.includes('--force');

const reports = await buildAllIndexes({ force });
const report = reports[0];   // curated, for the summary below

log('--- index report ---');
log(`corpus         : ${report.corpusDir}`);
log(`files indexed  : ${report.filesIndexed}`);
log(`files excluded : ${report.filesExcluded}` +
    (report.excluded.length ? ` (${report.excluded.map((e) => `${e.file} [${e.reason}]`).join(', ')})` : ''));
for (const s of report.sectionsScrubbed) log(`section scrub  : ${s.file} → removed ${s.sections.join(', ')}`);
log(`chunks         : ${report.chunkCount}`);
log(`reused / new   : ${report.filesReused} / ${report.filesEmbedded}`);
log(`dense enabled  : ${report.denseEnabled}${report.denseEnabled ? '' : ' — ' + report.denseDisabledReason}`);
log(`build seconds  : ${report.buildSeconds}`);
log(`index size     : ${(report.indexBytes / 1e6).toFixed(2)} MB  (${report.indexPath})`);
